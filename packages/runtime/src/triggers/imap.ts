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
//   - Holds one `setTimeout` handle per (owner, repo, workflowName,
//     triggerName), grouped per-(owner, repo) so
//     `reconfigure(owner, repo, entries)` only touches that pair's timers.
//   - Polls every `POLL_INTERVAL_MS` (default 60s). Each poll opens a fresh
//     IMAP connection, SELECTs the configured folder, runs the author's raw
//     UID SEARCH, FETCHes each match in turn, dispatches via the executor
//     (`entry.fire(parsedMsg)`), and applies `output.command` (or, on
//     handler error, `descriptor.onError.command`) verbatim.
//   - Re-arms only after the batch fully drains, so cross-poll re-entry is
//     impossible without explicit concurrency.
//   - Backs off exponentially up to `MAX_BACKOFF_MS` on transport-level
//     failures (connect / TLS / auth / search / fetch). One successful
//     batch resets cadence to `POLL_INTERVAL_MS`.
//
// Source-level errors (auth-failed, connect-failed, …) are routed through
// `deps.logger` only — they do not synthesize sandbox-emitted
// `trigger.error` events. Handler-failed events are emitted by the
// in-sandbox `trigger` plugin via `entry.fire`'s normal path.

const POLL_INTERVAL_MS = 60_000;
const BACKOFF_CAP_MINUTES = 15;
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

interface SourceEntry {
	readonly owner: string;
	readonly repo: string;
	readonly entry: TriggerEntry<ImapTriggerDescriptor>;
	timer: ReturnType<typeof setTimeout> | undefined;
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
	const result = (await (client as unknown as ExecCapableClient).exec(
		command,
		args,
		options,
	)) as ExecResult | undefined;
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups source state, poll/arm helpers, and TriggerSource lifecycle methods
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

	function arm(srcEntry: SourceEntry, delayMs: number): void {
		if (srcEntry.disposed) {
			return;
		}
		srcEntry.timer = setTimeout(() => {
			runPoll(srcEntry).catch(() => {
				// runPoll routes its own errors through deps.logger and re-arms;
				// this catch only guards against an unhandled rejection bringing
				// the process down on a transient failure.
			});
		}, delayMs);
	}

	function cancelPair(owner: string, repo: string): void {
		const map = pairs.get(pairKey(owner, repo));
		if (!map) {
			return;
		}
		for (const e of map.values()) {
			e.disposed = true;
			if (e.timer !== undefined) {
				clearTimeout(e.timer);
				e.timer = undefined;
			}
		}
	}

	function cancelAll(): void {
		for (const map of pairs.values()) {
			for (const e of map.values()) {
				e.disposed = true;
				if (e.timer !== undefined) {
					clearTimeout(e.timer);
					e.timer = undefined;
				}
			}
		}
	}

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: poll loop is naturally large; factoring it into smaller closures would obscure the linear "open → search → fetch each → fire → dispose → reschedule" flow that's the primary thing a reader wants to follow
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear protocol-state-machine — every branch is one IMAP step (connect/select/search/fetch/dispatch/dispose) with its own structured-logging error handler; splitting these into helpers would push state and error-routing through extra parameters
	async function runPoll(srcEntry: SourceEntry): Promise<void> {
		srcEntry.timer = undefined;
		if (!isCurrent(srcEntry) || srcEntry.disposed) {
			return;
		}
		const d = srcEntry.entry.descriptor;
		const logCtx = {
			owner: srcEntry.owner,
			repo: srcEntry.repo,
			workflow: d.workflowName,
			trigger: d.name,
			host: d.host,
			port: d.port,
		};
		let client: ImapFlow | undefined;
		let pollFailed = false;
		try {
			client = new ImapFlow({
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
				deps.logger.warn("imap.connect-failed", {
					...logCtx,
					reason: classifyConnectErr(err),
					error: errMessage(err),
				});
				pollFailed = true;
				return;
			}
			try {
				await client.mailboxOpen(d.folder);
			} catch (err) {
				deps.logger.warn("imap.search-failed", {
					...logCtx,
					stage: "mailboxOpen",
					folder: d.folder,
					error: errMessage(err),
				});
				pollFailed = true;
				return;
			}
			let uids: number[];
			try {
				uids = await execUidSearch(client, d.search);
			} catch (err) {
				deps.logger.warn("imap.search-failed", {
					...logCtx,
					stage: "search",
					search: d.search,
					error: errMessage(err),
				});
				pollFailed = true;
				return;
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
						deps.logger.warn("imap.fetch-failed", {
							...logCtx,
							uid,
							reason: "no-source",
						});
						continue;
					}
					parsedMsg = await parseRfc822(fetched.source, uid);
				} catch (err) {
					deps.logger.warn("imap.fetch-failed", {
						...logCtx,
						uid,
						error: errMessage(err),
					});
					continue;
				}
				let result: { ok: true; output: unknown } | { ok: false };
				try {
					result = (await srcEntry.entry.fire(parsedMsg)) as
						| { ok: true; output: unknown }
						| { ok: false };
				} catch (err) {
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
					deps.logger.warn("imap.disposition-failed", {
						...logCtx,
						uid,
						commands: dispositions,
						error: errMessage(err),
					});
					pollFailed = true;
					return;
				}
			}
		} finally {
			if (client !== undefined) {
				try {
					await client.logout();
				} catch {
					// best-effort
				}
			}
			if (!srcEntry.disposed && isCurrent(srcEntry)) {
				if (pollFailed) {
					srcEntry.failures += 1;
				} else {
					srcEntry.failures = 0;
				}
				arm(srcEntry, nextDelay(srcEntry.failures));
			}
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
					timer: undefined,
					failures: 0,
					disposed: false,
				};
				pairMap.set(
					entryKey(entry.descriptor.workflowName, entry.descriptor.name),
					srcEntry,
				);
				// First poll fires immediately; subsequent ones at POLL_INTERVAL_MS.
				arm(srcEntry, 0);
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
