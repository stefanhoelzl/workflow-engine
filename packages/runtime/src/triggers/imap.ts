import type { ImapMessage } from "@workflow-engine/core";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import type { ImapTriggerDescriptor } from "../executor/types.js";
import type { Logger } from "../logger.js";
import type {
	ReconfigureResult,
	TriggerEntry,
	TriggerSource,
} from "./source.js";

// ---------------------------------------------------------------------------
// IMAP TriggerSource
// ---------------------------------------------------------------------------
//
// `createImapTriggerSource` is the imap-kind protocol adapter. The source:
//   - Holds one persistent IMAP connection per (owner, repo, workflowName,
//     triggerName), grouped per-(owner, repo) so
//     `reconfigure(owner, repo, entries)` only touches that pair's connections.
//   - Drives each entry via a unified main loop:
//       while (!disposed) { await wakeup.next(); await drain(); }
//     Mode-specific behaviour is encapsulated in a `Wakeup` interface:
//     `pollWakeup` (60s setTimeout) for `mode: "poll"`, `idleWakeup`
//     (RFC 2177 IDLE + dirty flag) for `mode: "idle"`. The mid-drain
//     EXISTS race is handled inside `idleWakeup`; the main loop is
//     mode-agnostic.
//   - On every successful (re)connect, runs a post-connect drain to
//     close the gap window during which IDLE pushes were not observable.
//   - On any error (transport, auth, capability, search, disposition),
//     disconnects and schedules reconnect via exponential backoff
//     (60s → 60min). One successful drain resets the failure counter.
//
// Author-fixable failures (connect refused, mailbox missing, search
// rejected, fetch failed, disposition rejected) are aggregated per
// `drain()` call and surfaced through `entry.exception(...)` at most
// once per drain as a `trigger.exception` leaf event. Each failed
// reconnect attempt also emits its own exception (no extra throttling
// beyond the natural exp-backoff cadence). The IMAP source never
// imports `EventBus`, the executor, or any stamping helper —
// `entry.exception` is its only outbound channel for failures.
// Engine-bug paths (the registry-built `entry.fire` closure itself
// throws) stay log-only via `deps.logger.error("imap.fire-threw", …)`.
// Handler-failed events are emitted by the in-sandbox `trigger` plugin
// via `entry.fire`'s normal path.

const POLL_INTERVAL_MS = 60_000;
const BACKOFF_CAP_MINUTES = 60;
const MS_PER_MINUTE = 60_000;
const MAX_BACKOFF_MS = BACKOFF_CAP_MINUTES * MS_PER_MINUTE;
const BACKOFF_BASE = 2;
// Top-level regex patterns (biome's `useTopLevelRegex` requires hoisting
// out of any function for engine-cache-friendliness).
const SEARCH_TOKEN_RE = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
const ESCAPED_CHAR_RE = /\\(.)/g;
const DIGIT_ONLY_RE = /^\d+$/;
const UID_STORE_RE = /^(\d+)\s+([+-]?)FLAGS(?:\.SILENT)?\s+\(([^)]*)\)\s*$/i;
const UID_ARG_FOLDER_RE = /^(\d+)\s+(\S.*)$/;
const UID_ONLY_RE = /^(\d+)\s*$/;
const WHITESPACE_RE = /\s+/;
// `Math.floor(base64.length * 3 / 4)` is the standard base64 → bytes-decoded
// approximation (each 4 base64 chars decode to 3 bytes; we ignore padding).
const BASE64_BYTES_NUMERATOR = 3;
const BASE64_BYTES_DENOMINATOR = 4;

interface ImapTriggerSourceDeps {
	readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// Wakeup driver — the per-entry "block until it's time to drain again"
// abstraction. Two implementations: `pollWakeup` (setTimeout-backed, used
// for `mode: "poll"`) and `idleWakeup` (RFC 2177 IDLE + dirty flag,
// constructed in PR 2). The main loop is mode-agnostic; mode-specific
// behavior lives entirely behind this interface.

interface Wakeup {
	// Block until the loop should drain again. Implementations are
	// responsible for capturing wake-up signals that arrive during a
	// caller's drain so that mid-drain events produce an immediate
	// next-iteration return on the following call.
	next(): Promise<void>;
	// Resolve any pending next() Promise; release timers/listeners.
	dispose(): void;
}

function pollWakeup(intervalMs: number): Wakeup {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingResolve: (() => void) | undefined;
	return {
		next(): Promise<void> {
			return new Promise<void>((resolve) => {
				pendingResolve = resolve;
				timer = setTimeout(() => {
					timer = undefined;
					const r = pendingResolve;
					pendingResolve = undefined;
					r?.();
				}, intervalMs);
			});
		},
		dispose(): void {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			const r = pendingResolve;
			pendingResolve = undefined;
			r?.();
		},
	};
}

// idleWakeup — RFC 2177 driver. Registers a single client.on("exists")
// listener at construction (lives across drains). The listener flips an
// internal dirty flag and resolves any pending next() Promise. The
// dirty re-check is performed INSIDE the Promise executor (after the
// resolver is installed), closing the race between dirty-check and
// listener-fire. EXPUNGE and FLAGS events are intentionally NOT listened
// for — they signal mutations to existing mail, not new arrivals.
function idleWakeup(client: ImapFlow): Wakeup {
	let dirty = false;
	let pendingResolve: (() => void) | undefined;
	const listener = (): void => {
		dirty = true;
		const r = pendingResolve;
		pendingResolve = undefined;
		r?.();
	};
	client.on("exists", listener);
	return {
		next(): Promise<void> {
			return new Promise<void>((resolve) => {
				pendingResolve = resolve;
				if (dirty) {
					// Captured during the prior drain (or in the microsecond
					// gap before this Promise's executor ran). Short-circuit.
					dirty = false;
					pendingResolve = undefined;
					resolve();
					return;
				}
				// Arm IDLE inside the executor. The returned Promise resolves
				// when IDLE is broken (by the next drain command via
				// client.preCheck, or by logout); we discard it because the
				// listener is what wakes next(). client.idle() is a no-op if
				// IDLE is already active.
				client.idle().catch(() => {
					// IDLE breaks are normal; the connection close path
					// emits its own error event.
				});
			});
		},
		dispose(): void {
			client.removeListener("exists", listener);
			const r = pendingResolve;
			pendingResolve = undefined;
			r?.();
		},
	};
}

interface SourceEntry {
	readonly owner: string;
	readonly repo: string;
	readonly entry: TriggerEntry<ImapTriggerDescriptor>;
	// The persistent IMAP client for this entry (created by setupConnection).
	// Cleared on disconnect; recreated on reconnect.
	client: ImapFlow | undefined;
	// The Wakeup driver chosen at setupConnection (PollWakeup or, in PR 2,
	// IdleWakeup). Disposed on disconnect/reconfigure.
	wakeup: Wakeup | undefined;
	// Reconnect timer (between connection attempts). Distinct from any
	// timer the Wakeup itself owns.
	reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	failures: number;
	disposed: boolean;
}

interface ImapTriggerSource
	extends TriggerSource<"imap", ImapTriggerDescriptor> {
	getEntry(
		owner: string,
		repo: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry<ImapTriggerDescriptor> | undefined;
}

function entryKey(workflowName: string, triggerName: string): string {
	return `${workflowName}/${triggerName}`;
}

function pairKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
}

function nextDelay(failures: number): number {
	if (failures === 0) {
		return POLL_INTERVAL_MS;
	}
	const exp = POLL_INTERVAL_MS * BACKOFF_BASE ** (failures - 1);
	return Math.min(exp, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// SEARCH passthrough — author writes a raw IMAP SEARCH string. Tokenize it
// (respecting double-quoted runs) and emit imapflow ATOM/STRING attributes
// for `client.exec("UID SEARCH", attributes, { untagged })`. We capture the
// untagged SEARCH response via the same `untagged.SEARCH` hook imapflow
// uses internally.

interface SearchAttribute {
	readonly type: "ATOM" | "STRING";
	readonly value: string;
}

function tokenizeSearch(raw: string): SearchAttribute[] {
	const tokens: SearchAttribute[] = [];
	// Reset lastIndex on the shared global regex before iterating.
	SEARCH_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic JS regex iteration
	while ((m = SEARCH_TOKEN_RE.exec(raw)) !== null) {
		if (m[1] !== undefined) {
			tokens.push({
				type: "STRING",
				value: m[1].replace(ESCAPED_CHAR_RE, "$1"),
			});
		} else if (m[2] !== undefined) {
			tokens.push({ type: "ATOM", value: m[2] });
		}
	}
	return tokens;
}

interface ExecResult {
	readonly response?: unknown;
	readonly next?: () => void;
}

interface ExecCapableClient {
	exec(
		command: string,
		args?: SearchAttribute[],
		options?: {
			untagged?: Record<
				string,
				(untagged: { attributes?: { value?: unknown }[] }) => Promise<void>
			>;
		},
	): Promise<ExecResult | unknown>;
}

// imapflow's `exec()` resolves with `{ response, next }`. The parser is paused
// until the caller invokes `next()` — without it, every subsequent command
// hangs waiting for a response slot. Wrap exec to always release the parser.
//
// Additionally: imapflow's high-level methods (search, fetchOne, etc.) go
// through `run()` which awaits `client.preCheck` to break any active IDLE
// before issuing the next command. Raw `exec()` bypasses this. To make
// raw-exec commands (UID SEARCH, UID EXPUNGE, raw fallback) IDLE-aware, we
// invoke `preCheck` ourselves before calling `exec`. When IDLE is not
// active, `preCheck` is `false` and the call is a no-op.
async function execAndRelease(
	client: ImapFlow,
	command: string,
	args?: SearchAttribute[],
	options?: {
		untagged?: Record<
			string,
			(untagged: { attributes?: { value?: unknown }[] }) => Promise<void>
		>;
	},
): Promise<void> {
	const c = client as unknown as ExecCapableClient & {
		preCheck?: false | (() => Promise<void>);
	};
	if (typeof c.preCheck === "function") {
		await c.preCheck();
	}
	const result = (await c.exec(command, args, options)) as
		| ExecResult
		| undefined;
	if (result && typeof result.next === "function") {
		result.next();
	}
}

async function execUidSearch(
	client: ImapFlow,
	rawSearch: string,
): Promise<number[]> {
	const attributes = tokenizeSearch(rawSearch);
	const results = new Set<number>();
	await execAndRelease(client, "UID SEARCH", attributes, {
		untagged: {
			// biome-ignore lint/style/useNamingConvention: IMAP untagged-response keys are protocol-defined and case-sensitive (must match the server's all-caps `* SEARCH ...` line)
			// biome-ignore lint/suspicious/useAwait: imapflow's untagged-handler signature requires a Promise return; the synchronous handler still satisfies it without an inner await
			SEARCH: async (untagged) => {
				const attrs = untagged.attributes ?? [];
				for (const attr of attrs) {
					if (
						attr &&
						typeof attr.value === "string" &&
						DIGIT_ONLY_RE.test(attr.value)
					) {
						results.add(Number(attr.value));
					}
				}
			},
		},
	});
	return [...results].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Disposition execution — author writes the full UID-scoped IMAP command;
// we dispatch known verbs to imapflow's typed methods and fall back to
// `client.exec` for anything else. No validation — bad commands surface as
// server NO/BAD responses logged through `disposition-failed`.

interface ParsedDisposition {
	readonly verb: string;
	readonly rest: string;
}

const UID_PREFIX_LEN = 4;
const DECIMAL_RADIX = 10;

function parseDisposition(raw: string): ParsedDisposition {
	const trimmed = raw.trim();
	const upper = trimmed.toUpperCase();
	let verbEnd: number;
	if (upper.startsWith("UID ")) {
		const space2 = trimmed.indexOf(" ", UID_PREFIX_LEN);
		verbEnd = space2 === -1 ? trimmed.length : space2;
	} else {
		const space1 = trimmed.indexOf(" ");
		verbEnd = space1 === -1 ? trimmed.length : space1;
	}
	return {
		verb: trimmed.slice(0, verbEnd).toUpperCase(),
		rest: verbEnd < trimmed.length ? trimmed.slice(verbEnd + 1) : "",
	};
}

function decodeOp(s: string | undefined): "+" | "-" | "=" {
	if (s === "+") {
		return "+";
	}
	if (s === "-") {
		return "-";
	}
	return "=";
}

function parseUidStore(rest: string):
	| {
			readonly uid: number;
			readonly op: "+" | "-" | "=";
			readonly flags: string[];
	  }
	| undefined {
	const m = rest.match(UID_STORE_RE);
	if (!m) {
		return;
	}
	const uid = Number.parseInt(m[1] ?? "0", DECIMAL_RADIX);
	if (!Number.isFinite(uid) || uid <= 0) {
		return;
	}
	const flagsRaw = (m[3] ?? "").trim();
	const flags = flagsRaw === "" ? [] : flagsRaw.split(WHITESPACE_RE);
	return { uid, op: decodeOp(m[2]), flags };
}

function parseUidArgFolder(
	rest: string,
): { readonly uid: number; readonly folder: string } | undefined {
	const m = rest.match(UID_ARG_FOLDER_RE);
	if (!m) {
		return;
	}
	const uid = Number.parseInt(m[1] ?? "0", DECIMAL_RADIX);
	if (!Number.isFinite(uid) || uid <= 0) {
		return;
	}
	const folder = (m[2] ?? "").trim();
	if (folder === "") {
		return;
	}
	return { uid, folder };
}

function parseUidOnly(rest: string): number | undefined {
	const m = rest.match(UID_ONLY_RE);
	if (!m) {
		return;
	}
	const uid = Number.parseInt(m[1] ?? "0", DECIMAL_RADIX);
	if (!Number.isFinite(uid) || uid <= 0) {
		return;
	}
	return uid;
}

async function execStoreFlags(
	client: ImapFlow,
	parsed: { uid: number; op: "+" | "-" | "="; flags: string[] },
): Promise<void> {
	const { uid, op, flags } = parsed;
	if (op === "+") {
		await client.messageFlagsAdd(uid, flags, { uid: true });
		return;
	}
	if (op === "-") {
		await client.messageFlagsRemove(uid, flags, { uid: true });
		return;
	}
	await client.messageFlagsSet(uid, flags, { uid: true });
}

async function execRawFallback(
	client: ImapFlow,
	command: string,
): Promise<void> {
	const firstSpace = command.indexOf(" ");
	if (firstSpace === -1) {
		await execAndRelease(client, command);
		return;
	}
	await execAndRelease(client, command.slice(0, firstSpace), [
		{ type: "ATOM", value: command.slice(firstSpace + 1) },
	]);
}

async function executeDisposition(
	client: ImapFlow,
	command: string,
): Promise<void> {
	const { verb, rest } = parseDisposition(command);
	if (verb === "UID STORE") {
		const parsed = parseUidStore(rest);
		if (parsed) {
			await execStoreFlags(client, parsed);
			return;
		}
	} else if (verb === "UID MOVE") {
		const parsed = parseUidArgFolder(rest);
		if (parsed) {
			await client.messageMove(parsed.uid, parsed.folder, { uid: true });
			return;
		}
	} else if (verb === "UID COPY") {
		const parsed = parseUidArgFolder(rest);
		if (parsed) {
			await client.messageCopy(parsed.uid, parsed.folder, { uid: true });
			return;
		}
	} else if (verb === "UID EXPUNGE") {
		const uid = parseUidOnly(rest);
		if (uid !== undefined) {
			await execAndRelease(client, "UID EXPUNGE", [
				{ type: "ATOM", value: uid.toString() },
			]);
			return;
		}
	} else if (verb === "EXPUNGE") {
		await execAndRelease(client, "EXPUNGE");
		return;
	}
	// Unknown verb or unparseable args — fall back to raw exec.
	await execRawFallback(client, command);
}

async function applyDispositions(
	client: ImapFlow,
	commands: readonly string[],
): Promise<void> {
	for (const cmd of commands) {
		// biome-ignore lint/performance/noAwaitInLoops: dispositions are sequential by author intent — a STORE+EXPUNGE pair must serialize
		await executeDisposition(client, cmd);
	}
}

// ---------------------------------------------------------------------------
// Address normalization — postal-mime's Address type also covers group
// syntax (`name: <a>, <b>;`) where `address` is undefined and `group` is
// populated. Treat groups as flattened recipients here.

interface PostalAddressLike {
	name?: string | undefined;
	address?: string | undefined;
	group?: readonly PostalAddressLike[] | undefined;
}

function flattenAddress(
	a: PostalAddressLike | undefined,
	out: Array<{ name?: string; address: string }>,
): void {
	if (!a) {
		return;
	}
	if (a.address && a.address !== "") {
		if (a.name && a.name !== "") {
			out.push({ name: a.name, address: a.address });
		} else {
			out.push({ address: a.address });
		}
		return;
	}
	if (a.group) {
		for (const g of a.group) {
			flattenAddress(g, out);
		}
	}
}

function toAddressList(
	arr: readonly PostalAddressLike[] | undefined,
): Array<{ name?: string; address: string }> {
	if (!arr) {
		return [];
	}
	const out: Array<{ name?: string; address: string }> = [];
	for (const a of arr) {
		flattenAddress(a, out);
	}
	return out;
}

function normalizeHeaders(
	headers: ReadonlyArray<{ key: string; value: string }> | undefined,
): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	if (!headers) {
		return out;
	}
	for (const h of headers) {
		const key = h.key.toLowerCase();
		if (out[key] === undefined) {
			out[key] = [];
		}
		out[key].push(h.value);
	}
	return out;
}

function normalizeReferences(refs: unknown): string[] {
	if (typeof refs === "string") {
		return refs.split(WHITESPACE_RE).filter((s) => s !== "");
	}
	if (Array.isArray(refs)) {
		return refs;
	}
	return [];
}

interface PostalAttachmentLike {
	readonly filename?: string | null;
	readonly mimeType?: string;
	readonly contentId?: string;
	readonly disposition?: string | null;
	readonly content?: string | unknown;
}

function normalizeAttachment(
	att: PostalAttachmentLike,
): ImapMessage["attachments"][number] {
	const content = typeof att.content === "string" ? att.content : "";
	const size = Math.floor(
		(content.length * BASE64_BYTES_NUMERATOR) / BASE64_BYTES_DENOMINATOR,
	);
	const disposition =
		att.disposition === "inline" || att.disposition === "attachment"
			? (att.disposition as "inline" | "attachment")
			: undefined;
	return {
		...(att.filename !== undefined && att.filename !== null
			? { filename: att.filename }
			: {}),
		contentType: att.mimeType ?? "application/octet-stream",
		size,
		...(att.contentId ? { contentId: att.contentId } : {}),
		...(disposition === undefined ? {} : { contentDisposition: disposition }),
		content,
	};
}

async function parseRfc822(source: Buffer, uid: number): Promise<ImapMessage> {
	const parsed = await PostalMime.parse(source, {
		attachmentEncoding: "base64",
	});
	const fromList: Array<{ name?: string; address: string }> = [];
	flattenAddress(parsed.from as PostalAddressLike | undefined, fromList);
	const attachments = (parsed.attachments ?? []).map(normalizeAttachment);
	return {
		uid,
		...(parsed.messageId !== undefined && parsed.messageId !== ""
			? { messageId: parsed.messageId }
			: {}),
		...(parsed.inReplyTo !== undefined && parsed.inReplyTo !== ""
			? { inReplyTo: parsed.inReplyTo }
			: {}),
		references: normalizeReferences(parsed.references),
		from: fromList[0] ?? { address: "" },
		to: toAddressList(parsed.to as readonly PostalAddressLike[] | undefined),
		cc: toAddressList(parsed.cc as readonly PostalAddressLike[] | undefined),
		bcc: toAddressList(parsed.bcc as readonly PostalAddressLike[] | undefined),
		...(parsed.replyTo
			? {
					replyTo: toAddressList(
						parsed.replyTo as readonly PostalAddressLike[],
					),
				}
			: {}),
		subject: parsed.subject ?? "",
		date: parsed.date ?? new Date(0).toISOString(),
		...(parsed.text === undefined ? {} : { text: parsed.text }),
		...(parsed.html === undefined ? {} : { html: parsed.html }),
		headers: normalizeHeaders(parsed.headers),
		attachments,
	};
}

// ---------------------------------------------------------------------------
// Source factory
//
// Architecture:
//   - One persistent IMAP connection per (owner, repo, workflow, trigger).
//   - Connection lifecycle:
//       disconnected → setupConnection() → ready → main loop → drain()
//                                              ↑                  │
//                                              └── on close/error ┘
//                                                  (schedule reconnect
//                                                   via exp backoff)
//   - Main loop is mode-agnostic:
//       while (!entry.disposed) {
//         await entry.wakeup.next()
//         await drain(entry, client)
//       }
//   - Mode-specific behavior lives in the Wakeup implementation
//     (pollWakeup / idleWakeup); drain, reconnect, exception
//     aggregation, and post-connect drain are shared.

interface DrainOutcome {
	readonly failed: boolean;
	readonly fatal:
		| {
				readonly stage: "connect" | "mailboxOpen" | "search" | "disposition";
				readonly failedUid?: number;
				readonly error: { readonly message: string };
		  }
		| undefined;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups source state, lifecycle helpers, drain body, and TriggerSource methods — splitting them across files would push significant state through parameters
function createImapTriggerSource(
	deps: ImapTriggerSourceDeps,
): ImapTriggerSource {
	const pairs = new Map<string, Map<string, SourceEntry>>();

	function isCurrent(srcEntry: SourceEntry): boolean {
		const pairMap = pairs.get(pairKey(srcEntry.owner, srcEntry.repo));
		if (!pairMap) {
			return false;
		}
		const key = entryKey(
			srcEntry.entry.descriptor.workflowName,
			srcEntry.entry.descriptor.name,
		);
		return pairMap.get(key) === srcEntry;
	}

	function teardownConnection(srcEntry: SourceEntry): void {
		const w = srcEntry.wakeup;
		srcEntry.wakeup = undefined;
		w?.dispose();
		const c = srcEntry.client;
		srcEntry.client = undefined;
		if (c !== undefined) {
			// Fire-and-forget logout. Disconnection paths must not race with
			// the main loop's next iteration; awaiting here would re-enter
			// the loop's await-tree and potentially deadlock against the
			// reconnect path. We use `.catch()` (not `void`) so unhandled
			// rejections are swallowed without the no-void lint trip.
			c.logout().catch(() => {
				// best-effort
			});
		}
	}

	function disposeEntry(srcEntry: SourceEntry): void {
		srcEntry.disposed = true;
		if (srcEntry.reconnectTimer !== undefined) {
			clearTimeout(srcEntry.reconnectTimer);
			srcEntry.reconnectTimer = undefined;
		}
		teardownConnection(srcEntry);
	}

	function cancelPair(owner: string, repo: string): void {
		const map = pairs.get(pairKey(owner, repo));
		if (!map) {
			return;
		}
		for (const e of map.values()) {
			disposeEntry(e);
		}
	}

	function cancelAll(): void {
		for (const map of pairs.values()) {
			for (const e of map.values()) {
				disposeEntry(e);
			}
		}
	}

	function scheduleReconnect(srcEntry: SourceEntry): void {
		if (srcEntry.disposed || !isCurrent(srcEntry)) {
			return;
		}
		teardownConnection(srcEntry);
		const delay = nextDelay(srcEntry.failures);
		srcEntry.reconnectTimer = setTimeout(() => {
			srcEntry.reconnectTimer = undefined;
			runEntry(srcEntry).catch(() => {
				// runEntry routes its own errors through entry.exception
				// and re-schedules reconnect via scheduleReconnect; this
				// catch only guards against an unhandled rejection bringing
				// the process down on a truly unexpected throw.
			});
		}, delay);
	}

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: drain is naturally large; factoring it would obscure the linear "search → fetch each → fire → disposition" protocol flow
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear protocol-state-machine — every branch is one IMAP step with its own error path
	async function drain(
		srcEntry: SourceEntry,
		client: ImapFlow,
	): Promise<DrainOutcome> {
		const d = srcEntry.entry.descriptor;
		const logCtx = {
			owner: srcEntry.owner,
			repo: srcEntry.repo,
			workflow: d.workflowName,
			trigger: d.name,
			host: d.host,
			port: d.port,
		};
		// Per-drain aggregator. `firstFatal` captures the first stage that
		// aborts the drain (search / disposition); pre-loop stages
		// (connect / mailboxOpen) are owned by setupConnection, not drain.
		// `failedFetchUids` accumulates per-UID fetch failures, which do
		// NOT abort the drain; `lastFetchErr` retains the most recent
		// fetch error message for the β.2 "fetch-only" emission.
		let firstFatal:
			| {
					readonly stage: "search" | "disposition";
					readonly failedUid?: number;
					readonly error: { readonly message: string };
			  }
			| undefined;
		const failedFetchUids: number[] = [];
		let lastFetchErr: { readonly message: string } | undefined;
		try {
			let uids: number[];
			try {
				uids = await execUidSearch(client, d.search);
			} catch (err) {
				firstFatal = {
					stage: "search",
					error: { message: errMessage(err) },
				};
				return { failed: true, fatal: firstFatal };
			}
			for (const uid of uids) {
				if (srcEntry.disposed) {
					break;
				}
				let parsedMsg: ImapMessage;
				try {
					// biome-ignore lint/performance/noAwaitInLoops: per-message dispatch is intentionally serial — the connection is shared and the handler-output dispatch must complete before fetching the next UID
					const fetched = await client.fetchOne(uid, {
						source: true,
						uid: true,
					});
					if (fetched === false || !fetched.source) {
						failedFetchUids.push(uid);
						lastFetchErr = { message: "no-source" };
						continue;
					}
					parsedMsg = await parseRfc822(fetched.source, uid);
				} catch (err) {
					failedFetchUids.push(uid);
					lastFetchErr = { message: errMessage(err) };
					continue;
				}
				let result: { ok: true; output: unknown } | { ok: false };
				try {
					result = (await srcEntry.entry.fire(parsedMsg)) as
						| { ok: true; output: unknown }
						| { ok: false };
				} catch (err) {
					// Engine bug: the registry-built fire closure itself threw.
					// Stays log-only — NOT routed through entry.exception.
					deps.logger.error("imap.fire-threw", {
						...logCtx,
						uid,
						error: errMessage(err),
					});
					result = { ok: false };
				}
				const dispositions = result.ok
					? extractCommands(result.output)
					: [...(d.onError.command ?? [])];
				if (dispositions.length === 0) {
					continue;
				}
				try {
					await applyDispositions(client, dispositions);
				} catch (err) {
					firstFatal = {
						stage: "disposition",
						failedUid: uid,
						error: { message: errMessage(err) },
					};
					return { failed: true, fatal: firstFatal };
				}
			}
			return { failed: false, fatal: undefined };
		} finally {
			// Aggregator → at most one entry.exception per drain. Fatal stage
			// wins over per-UID fetch failures; a clean drain emits nothing.
			if (firstFatal !== undefined) {
				const failedUids =
					firstFatal.stage === "disposition" &&
					firstFatal.failedUid !== undefined
						? [firstFatal.failedUid]
						: [];
				try {
					await srcEntry.entry.exception({
						name: "imap.poll-failed",
						error: firstFatal.error,
						details: { stage: firstFatal.stage, failedUids },
					});
				} catch {
					// best-effort: never let an emission failure crash the loop
				}
			} else if (failedFetchUids.length > 0) {
				try {
					await srcEntry.entry.exception({
						name: "imap.poll-failed",
						error: lastFetchErr ?? { message: "fetch failed" },
						details: { stage: "fetch", failedUids: [...failedFetchUids] },
					});
				} catch {
					// best-effort
				}
			}
		}
	}

	async function emitConnectFailure(
		srcEntry: SourceEntry,
		stage: "connect" | "mailboxOpen",
		err: unknown,
	): Promise<void> {
		const message = stage === "connect" ? connectErrText(err) : errMessage(err);
		try {
			await srcEntry.entry.exception({
				name: "imap.poll-failed",
				error: { message },
				details: { stage, failedUids: [] },
			});
		} catch {
			// best-effort
		}
	}

	// setupConnection: one attempt to bring an entry from disconnected to
	// ready. Order is load-bearing for the listener-before-SELECT invariant
	// (when IdleWakeup is used, the on("exists") listener it installs MUST
	// be registered before mailboxOpen so an EXISTS arriving during SELECT
	// is captured). Returns true on success; false on a connect-stage
	// failure (caller should call scheduleReconnect).
	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: linear setup pipeline (connect → wakeup → mailboxOpen → close-handlers → post-connect drain) with stage-specific error branches; splitting it would obscure the listener-before-SELECT invariant
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch defends one connect-stage failure mode (capability missing, mailboxOpen failure, drain failure); merging or splitting them would compromise the recovery semantics
	async function setupConnection(srcEntry: SourceEntry): Promise<boolean> {
		const d = srcEntry.entry.descriptor;
		const client = new ImapFlow({
			host: d.host,
			port: d.port,
			secure: d.tls === "required",
			auth: { user: d.user, pass: d.password },
			tls: { rejectUnauthorized: !d.insecureSkipVerify },
			logger: false,
			emitLogs: false,
		});
		try {
			await client.connect();
		} catch (err) {
			await emitConnectFailure(srcEntry, "connect", err);
			// Best-effort close of any half-open socket the failed connect
			// may have left behind.
			try {
				await client.logout();
			} catch {
				// best-effort
			}
			srcEntry.failures += 1;
			scheduleReconnect(srcEntry);
			return false;
		}
		// Capability check for mode: "idle". A server that doesn't advertise
		// IDLE is treated as a recoverable connect-stage failure; the entry
		// reconnects via exp backoff and re-checks on each attempt.
		if (d.mode === "idle" && !client.capabilities.has("IDLE")) {
			await emitConnectFailure(
				srcEntry,
				"connect",
				new Error(
					"IDLE capability missing: server does not advertise RFC 2177 IDLE",
				),
			);
			try {
				await client.logout();
			} catch {
				// best-effort
			}
			srcEntry.failures += 1;
			scheduleReconnect(srcEntry);
			return false;
		}
		// Construct Wakeup AFTER connect and BEFORE mailboxOpen — this is
		// the listener-before-SELECT invariant. idleWakeup installs the
		// EXISTS listener inside the constructor; pollWakeup is timer-only.
		srcEntry.wakeup =
			d.mode === "idle" ? idleWakeup(client) : pollWakeup(POLL_INTERVAL_MS);
		try {
			await client.mailboxOpen(d.folder);
		} catch (err) {
			await emitConnectFailure(srcEntry, "mailboxOpen", err);
			srcEntry.wakeup.dispose();
			srcEntry.wakeup = undefined;
			try {
				await client.logout();
			} catch {
				// best-effort
			}
			srcEntry.failures += 1;
			scheduleReconnect(srcEntry);
			return false;
		}
		// Wire close/error handlers BEFORE the post-connect drain runs, so
		// a disconnect mid-drain is captured.
		client.on("close", () => onConnectionLost(srcEntry));
		client.on("error", () => onConnectionLost(srcEntry));
		srcEntry.client = client;
		// Post-connect drain: gap recovery for messages that arrived while
		// disconnected. Treats failures the same as in-loop drains.
		const outcome = await drain(srcEntry, client);
		if (outcome.failed) {
			// search/disposition failure on cold start — close and reconnect.
			scheduleReconnect(srcEntry);
			srcEntry.failures += 1;
			return false;
		}
		// success — reset failure counter
		srcEntry.failures = 0;
		return true;
	}

	function onConnectionLost(srcEntry: SourceEntry): void {
		if (srcEntry.disposed || !isCurrent(srcEntry)) {
			return;
		}
		if (srcEntry.client === undefined && srcEntry.wakeup === undefined) {
			// already torn down (e.g. by scheduleReconnect itself)
			return;
		}
		srcEntry.failures += 1;
		scheduleReconnect(srcEntry);
	}

	// runEntry: one full lifecycle attempt from disconnected → ready →
	// main loop. Returns when the connection is lost (close/error fires
	// scheduleReconnect, which will re-enter via the reconnect timer)
	// or when the entry is disposed.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear lifecycle (setup → main loop with disposal/reconnect checks) — every branch defends one disposal/disconnect race, splitting them would push state through extra parameters
	async function runEntry(srcEntry: SourceEntry): Promise<void> {
		if (srcEntry.disposed || !isCurrent(srcEntry)) {
			return;
		}
		const ok = await setupConnection(srcEntry);
		if (!ok) {
			return;
		}
		// Main loop: shared between modes.
		while (!srcEntry.disposed && isCurrent(srcEntry)) {
			const wakeup = srcEntry.wakeup;
			const client = srcEntry.client;
			if (wakeup === undefined || client === undefined) {
				// Connection lost mid-loop; reconnect was scheduled.
				return;
			}
			// biome-ignore lint/performance/noAwaitInLoops: main loop is sequential by design — wakeup → drain → wakeup
			await wakeup.next();
			if (srcEntry.disposed || !isCurrent(srcEntry)) {
				return;
			}
			if (srcEntry.client !== client) {
				// Connection was torn down while we were blocked in next();
				// the new connection (if any) will be driven by a fresh
				// runEntry invocation.
				return;
			}
			const outcome = await drain(srcEntry, client);
			if (outcome.failed) {
				// search/disposition failure → disconnect + reconnect
				srcEntry.failures += 1;
				scheduleReconnect(srcEntry);
				return;
			}
			// successful drain resets the failure counter
			srcEntry.failures = 0;
		}
	}

	return {
		kind: "imap",
		start() {
			return Promise.resolve();
		},
		stop() {
			cancelAll();
			pairs.clear();
			return Promise.resolve();
		},
		reconfigure(
			owner: string,
			repo: string,
			entries: readonly TriggerEntry<ImapTriggerDescriptor>[],
		): Promise<ReconfigureResult> {
			const key = pairKey(owner, repo);
			cancelPair(owner, repo);
			pairs.delete(key);
			if (entries.length === 0) {
				return Promise.resolve({ ok: true });
			}
			const pairMap = new Map<string, SourceEntry>();
			pairs.set(key, pairMap);
			for (const entry of entries) {
				const srcEntry: SourceEntry = {
					owner,
					repo,
					entry,
					client: undefined,
					wakeup: undefined,
					reconnectTimer: undefined,
					failures: 0,
					disposed: false,
				};
				pairMap.set(
					entryKey(entry.descriptor.workflowName, entry.descriptor.name),
					srcEntry,
				);
				// First connect fires immediately; subsequent reconnects via
				// scheduleReconnect with exp backoff.
				runEntry(srcEntry).catch(() => {
					// runEntry handles its own errors; this catch guards
					// against truly unexpected throws.
				});
			}
			return Promise.resolve({ ok: true });
		},
		getEntry(owner, repo, workflowName, triggerName) {
			return pairs
				.get(pairKey(owner, repo))
				?.get(entryKey(workflowName, triggerName))?.entry;
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers

function connectErrText(err: unknown): string {
	return `${classifyConnectErr(err)}: ${errMessage(err)}`;
}

function classifyConnectErr(err: unknown): string {
	const msg = errMessage(err).toLowerCase();
	if (msg.includes("authenticationfailed") || msg.includes("auth")) {
		return "auth-failed";
	}
	if (
		msg.includes("certificate") ||
		msg.includes("tls") ||
		msg.includes("ssl")
	) {
		return "tls-failed";
	}
	return "connect-failed";
}

function errMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function extractCommands(output: unknown): string[] {
	if (output === null || typeof output !== "object") {
		return [];
	}
	const o = output as { command?: unknown };
	if (!Array.isArray(o.command)) {
		return [];
	}
	return o.command.filter((c): c is string => typeof c === "string");
}

export type { ImapTriggerSource };
export { createImapTriggerSource };
