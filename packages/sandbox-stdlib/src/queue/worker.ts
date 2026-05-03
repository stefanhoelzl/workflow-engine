import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as fsOpen, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QUEUE_NAME_RE, z } from "@workflow-engine/core";
import type {
	GuestFunctionDescription,
	PluginContext,
	PluginSetup,
	RunInput,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";
import { QUEUE_DISPATCHER_NAME } from "./descriptor-name.js";
import { QueueError } from "./queue-error.js";
import type {
	QueueGetResultWire,
	QueueInputWire,
	QueuePutResultWire,
	QueueResultWire,
	QueueRunExtras,
} from "./types.js";

const MAX_ITEM_BYTES = 1024;
const MAX_QUEUE_DEPTH = 1000;

// ---------------------------------------------------------------------------
// Plugin config (shipped from the main thread, JSON-serialisable across the
// postMessage boundary)
// ---------------------------------------------------------------------------

interface Config {
	// Per-sandbox owner. The sandbox cache key is `(owner, workflow.sha)`,
	// so this is stable for the sandbox's lifetime.
	readonly owner: string;
	// Workflow name (matches the manifest's `name`). Stable for sandbox
	// lifetime — a single sandbox serves one workflow file.
	readonly workflow: string;
	// Persistence root: `<PERSISTENCE_PATH>/queues`. Frozen.
	readonly queuesRoot: string;
	// Names of queues declared in the workflow's manifest. Bridge calls for
	// any other name surface as `queue.notDeclared`.
	readonly declaredQueues: readonly string[];
	// JSON Schema per queue, keyed by queue name. Rehydrated to Zod
	// validators at worker boot.
	readonly schemas: Readonly<Record<string, Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Per-run repo capture (stamped by runtime via RunInput.extras)
// ---------------------------------------------------------------------------

let activeRepo: string | null = null;

function onBeforeRunStarted(runInput: RunInput): true | undefined {
	const extras = runInput.extras as QueueRunExtras | undefined;
	const q = extras?.queue;
	if (q && typeof q.repo === "string" && q.repo.length > 0) {
		activeRepo = q.repo;
	}
	return;
}

function onRunFinished(): void {
	activeRepo = null;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function assertInput(raw: unknown): QueueInputWire {
	if (raw === null || typeof raw !== "object") {
		throw new QueueError({
			code: "queue.notDeclared",
			message: "queue input must be an object",
		});
	}
	const o = raw as Record<string, unknown>;
	const op = o.op;
	const name = o.name;
	if (op !== "put" && op !== "get") {
		throw new QueueError({
			code: "queue.notDeclared",
			message: 'queue input.op must be "put" or "get"',
		});
	}
	if (typeof name !== "string" || !QUEUE_NAME_RE.test(name)) {
		// Defense in depth: build pipeline already enforces the regex on
		// every declared queue name, but a tampered guest could still send
		// arbitrary strings. Refuse before constructing any path.
		throw new QueueError({
			code: "queue.notDeclared",
			message: `queue name "${typeof name === "string" ? name : ""}" is not declared`,
		});
	}
	if (op === "put") {
		return { op, name, item: o.item };
	}
	return { op, name };
}

function assertDeclared(name: string, declared: readonly string[]): void {
	if (!declared.includes(name)) {
		throw new QueueError({
			code: "queue.notDeclared",
			message: `queue "${name}" is not declared`,
		});
	}
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface QueuePathSegments {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly name: string;
}

function resolveQueuePath(segments: QueuePathSegments): string {
	// All four path segments are runtime-controlled (per-sandbox config or
	// per-run extras stamped by the runtime); `name` is the only segment
	// derived from the manifest, and it's regex-validated at build time +
	// re-validated at the bridge entry. No path component originates in
	// untrusted guest input.
	return join(
		segments.queuesRoot,
		segments.owner,
		segments.repo,
		segments.workflow,
		`${segments.name}.ndjson`,
	);
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function readNofollowFlag(): number {
	// biome-ignore lint/style/useNamingConvention: O_NOFOLLOW is a libc/POSIX flag name; renaming would break the property-access path on `fsConstants` which uses the same casing
	return (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

const NOFOLLOW = readNofollowFlag();

// rwx for owner only on tmpfile; matches the standard 0o600 for user-private
// scratch files. Hoisted to avoid the no-magic-numbers lint at the call site.
const TMPFILE_MODE_OWNER_RW = 0o600;

// Open-flag bitmask combinations. POSIX open() flags are documented to
// compose via bitwise OR (`|`); the suppressions inside each helper name
// that fact. The helpers are immediately invoked so the rest of the module
// sees plain numbers, not function references.
function computeAppendNofollow(): number {
	// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose via bitwise OR
	return fsConstants.O_WRONLY | fsConstants.O_APPEND | NOFOLLOW;
}
function computeReadNofollow(): number {
	// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose via bitwise OR
	return fsConstants.O_RDONLY | NOFOLLOW;
}
function computeTmpfileCreate(): number {
	// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose via bitwise OR
	return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
}
const FLAGS_APPEND_NOFOLLOW = computeAppendNofollow();
const FLAGS_READ_NOFOLLOW = computeReadNofollow();
const FLAGS_TMPFILE_CREATE = computeTmpfileCreate();

function mapFsError(err: unknown): QueueError {
	const code = (err as { code?: string }).code;
	if (code === "ENOENT" || code === "ELOOP") {
		return new QueueError({
			code: "queue.gone",
			message: "queue file is unavailable",
		});
	}
	// Other filesystem errors (EACCES, ENOSPC, …) surface as `queue.gone`
	// rather than leaking errno values to the guest. Operator forensics
	// happen via the runtime's logger, which still captures the underlying
	// message in the structured-log line.
	return new QueueError({
		code: "queue.gone",
		message: "queue file is unavailable",
	});
}

async function appendLineFsynced(path: string, line: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof fsOpen>> | null = null;
	try {
		handle = await fsOpen(path, FLAGS_APPEND_NOFOLLOW);
		await handle.writeFile(line, "utf8");
		await handle.sync();
	} catch (err) {
		throw mapFsError(err);
	} finally {
		if (handle !== null) {
			try {
				await handle.close();
			} catch {
				/* close errors are non-fatal once data is durable */
			}
		}
	}
}

async function readQueueFile(path: string): Promise<string> {
	try {
		const buf = await readFile(path, {
			encoding: "utf8",
			flag: FLAGS_READ_NOFOLLOW,
		});
		return buf;
	} catch (err) {
		throw mapFsError(err);
	}
}

async function rewriteRemainderFsynced(
	path: string,
	remainder: string,
): Promise<void> {
	const tmpPath = `${path}.tmp.${randomUUID()}`;
	let handle: Awaited<ReturnType<typeof fsOpen>> | null = null;
	try {
		// Tmpfile can be created fresh — no NOFOLLOW concern because the path
		// is randomized per call. EXCL avoids clobbering a preexisting tmp.
		handle = await fsOpen(tmpPath, FLAGS_TMPFILE_CREATE, TMPFILE_MODE_OWNER_RW);
		await handle.writeFile(remainder, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(tmpPath, path);
		// fsync the parent directory so the rename itself reaches durable
		// media. POSIX requires this for crash-safe atomic file replacement.
		const dirHandle = await fsOpen(dirname(path), fsConstants.O_RDONLY);
		try {
			await dirHandle.sync();
		} finally {
			await dirHandle.close();
		}
	} catch (err) {
		// Best-effort tmpfile cleanup; ignore failures.
		try {
			await unlink(tmpPath);
		} catch {
			/* tmpfile may already be gone */
		}
		throw mapFsError(err);
	} finally {
		if (handle !== null) {
			try {
				await handle.close();
			} catch {
				/* ignore */
			}
		}
	}
}

// Count the number of newline-delimited entries in the file content. The
// last line may or may not end in `\n`; we count non-empty lines.
function countItems(content: string): number {
	if (content === "") {
		return 0;
	}
	let count = 0;
	for (const line of content.split("\n")) {
		if (line.length > 0) {
			count++;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Validators (rehydrated from JSON Schema at worker boot)
// ---------------------------------------------------------------------------

function rehydrateValidators(
	schemas: Readonly<Record<string, Record<string, unknown>>>,
): Map<string, z.ZodType<unknown>> {
	const validators = new Map<string, z.ZodType<unknown>>();
	for (const [queueName, schema] of Object.entries(schemas)) {
		validators.set(queueName, z.fromJSONSchema(schema) as z.ZodType<unknown>);
	}
	return validators;
}

// ---------------------------------------------------------------------------
// Op dispatch
// ---------------------------------------------------------------------------

function getValidator(
	validators: Map<string, z.ZodType<unknown>>,
	name: string,
): z.ZodType<unknown> {
	const v = validators.get(name);
	if (!v) {
		throw new QueueError({
			code: "queue.notDeclared",
			message: `queue "${name}" is not declared`,
		});
	}
	return v;
}

async function dispatchPut(
	config: Config,
	repo: string,
	validators: Map<string, z.ZodType<unknown>>,
	input: { name: string; item: unknown },
): Promise<QueuePutResultWire> {
	assertDeclared(input.name, config.declaredQueues);
	const validator = getValidator(validators, input.name);
	const parseResult = validator.safeParse(input.item);
	if (!parseResult.success) {
		throw new QueueError({
			code: "queue.schemaMismatch",
			message: "queue item failed schema validation on put",
		});
	}
	const encoded = JSON.stringify(parseResult.data);
	if (encoded === undefined) {
		// Unserializable item (BigInt, Symbol, etc.). The Zod schema should
		// already reject these, but defense in depth.
		throw new QueueError({
			code: "queue.schemaMismatch",
			message: "queue item is not JSON-serializable",
		});
	}
	const encodedBytes = Buffer.byteLength(encoded, "utf8");
	if (encodedBytes > MAX_ITEM_BYTES) {
		throw new QueueError({
			code: "queue.itemTooLarge",
			message: `queue item is ${String(encodedBytes)} bytes; max is ${String(MAX_ITEM_BYTES)}`,
		});
	}
	const path = resolveQueuePath({
		queuesRoot: config.queuesRoot,
		owner: config.owner,
		repo,
		workflow: config.workflow,
		name: input.name,
	});
	// Depth check: read current content and count lines. Rejects when at cap.
	const current = await readQueueFile(path);
	const depth = countItems(current);
	if (depth >= MAX_QUEUE_DEPTH) {
		throw new QueueError({
			code: "queue.full",
			message: `queue "${input.name}" is at capacity (${String(MAX_QUEUE_DEPTH)} items)`,
		});
	}
	await appendLineFsynced(path, `${encoded}\n`);
	return null;
}

interface PoppedHead {
	readonly headLine: string;
	readonly remainder: string;
}

// Split `content` into the head non-empty line + the rewrite payload (the
// rest of the file in NDJSON form, with one trailing `\n` per surviving
// item). Returns `null` when the file contains no non-empty lines.
function splitHead(content: string): PoppedHead | null {
	if (content === "") {
		return null;
	}
	const lines = content.split("\n");
	let headIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== "") {
			headIdx = i;
			break;
		}
	}
	if (headIdx === -1) {
		return null;
	}
	const headLine = lines[headIdx] as string;
	const remainderLines = lines.filter((_, i) => i !== headIdx);
	// Drop a trailing empty entry (artifact of the trailing `\n` on the
	// last item) so the rewritten file ends in exactly one `\n` per item.
	while (remainderLines.length > 0 && remainderLines.at(-1) === "") {
		remainderLines.pop();
	}
	const remainder =
		remainderLines.length === 0 ? "" : `${remainderLines.join("\n")}\n`;
	return { headLine, remainder };
}

// Validate the popped item against the queue's current schema. The item is
// already removed from the queue by the caller; on mismatch we throw with
// the item embedded so the paired `system.error` event carries it for
// recovery.
function validatePopped(
	headLine: string,
	validator: z.ZodType<unknown>,
): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(headLine);
	} catch {
		throw new QueueError({
			code: "queue.schemaMismatch",
			message: "queue item is not valid JSON",
			item: headLine,
		});
	}
	const parseResult = validator.safeParse(parsed);
	if (!parseResult.success) {
		throw new QueueError({
			code: "queue.schemaMismatch",
			message: "queue item failed schema validation on get",
			item: parsed,
		});
	}
	return parseResult.data;
}

async function dispatchGet(
	config: Config,
	repo: string,
	validators: Map<string, z.ZodType<unknown>>,
	input: { name: string },
): Promise<QueueGetResultWire> {
	assertDeclared(input.name, config.declaredQueues);
	const path = resolveQueuePath({
		queuesRoot: config.queuesRoot,
		owner: config.owner,
		repo,
		workflow: config.workflow,
		name: input.name,
	});
	const content = await readQueueFile(path);
	const popped = splitHead(content);
	if (popped === null) {
		return { found: false };
	}
	await rewriteRemainderFsynced(path, popped.remainder);
	const validator = getValidator(validators, input.name);
	const item = validatePopped(popped.headLine, validator);
	return { found: true, item };
}

// ---------------------------------------------------------------------------
// Descriptor + plugin setup
// ---------------------------------------------------------------------------
//
// File-existence invariant: the workflow registry's upload transaction
// creates an empty file for every declared queue (eager create), and the
// boot reconciliation sweep restores any missing file for a declared queue.
// The plugin therefore relies on the file existing for any name it accepts
// in `declaredQueues`. ENOENT surfaces as `queue.gone` so an orphaned
// in-flight invocation hitting a queue whose file was unlinked by a newer
// upload sees the typed error rather than silently succeeding.

function queueDispatcherDescriptor(
	config: Config,
	validators: Map<string, z.ZodType<unknown>>,
): GuestFunctionDescription {
	return {
		name: QUEUE_DISPATCHER_NAME,
		publicName: "queue",
		args: [Guest.raw()],
		result: Guest.raw(),
		handler: (async (raw: unknown) => {
			const input = assertInput(raw);
			const repo = activeRepo;
			if (repo === null || repo === "") {
				// Should never happen in production: the runtime always stamps
				// `extras.queue.repo` for invocations that may touch queues.
				throw new QueueError({
					code: "queue.notDeclared",
					message: "queue ops are unavailable in this run context",
				});
			}
			let result: QueueResultWire;
			if (input.op === "put") {
				result = await dispatchPut(config, repo, validators, input);
			} else {
				result = await dispatchGet(config, repo, validators, input);
			}
			return result as unknown as Record<string, unknown>;
		}) as unknown as GuestFunctionDescription["handler"],
		log: { request: "system" },
		logName: (args) => {
			const input = args[0] as { op?: string; name?: string } | undefined;
			if (!input || typeof input !== "object") {
				return "queue";
			}
			if (input.op === "put") {
				return "queue.put";
			}
			if (input.op === "get") {
				return "queue.get";
			}
			return "queue";
		},
		logInput: (args) => {
			const input = args[0] as
				| { op?: string; name?: string; item?: unknown }
				| undefined;
			if (!input || typeof input !== "object") {
				return args;
			}
			const picked: Record<string, unknown> = {};
			if (typeof input.op === "string") {
				picked.op = input.op;
			}
			if (typeof input.name === "string") {
				picked.name = input.name;
			}
			// Items are not logged on `put` to keep the event archive small;
			// the spec'd 1 KB cap means logging would still be bounded, but
			// queue items are author-domain payloads and shouldn't auto-leak
			// into logs alongside connection facts. Operators with a need
			// can read the on-disk file.
			return picked;
		},
		public: false,
	};
}

function worker(
	_ctx: PluginContext,
	_deps: unknown,
	config: Config,
): PluginSetup {
	const validators = rehydrateValidators(config.schemas);
	return {
		guestFunctions: [queueDispatcherDescriptor(config, validators)],
		onBeforeRunStarted,
		onRunFinished,
	};
}

export type { Config };
export {
	appendLineFsynced,
	assertInput,
	countItems,
	dispatchGet,
	dispatchPut,
	mapFsError,
	rehydrateValidators,
	resolveQueuePath,
	rewriteRemainderFsynced,
	worker,
};
