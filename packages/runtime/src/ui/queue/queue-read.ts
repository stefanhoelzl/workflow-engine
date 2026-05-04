import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Host-side, read-only inspection of queue NDJSON files. The runtime owns
// `<persistenceRoot>/queues/`; this module is the only path outside the
// queue lifecycle code that observes file contents. Per `queues/spec.md`
// (Host-side read-only inspection): no mutations, no locks, partial
// trailing lines are silently dropped (a concurrent `put` is a single
// `appendFile` syscall — a reader observing it mid-flight may see a
// truncated final line; valid lines before it are always intact).

interface QueueFsCoords {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queue: string;
}

interface ListOptions extends QueueFsCoords {
	readonly offset?: number;
	readonly limit?: number;
}

interface ListResult {
	readonly items: readonly unknown[];
	readonly total: number;
}

function queueFilePath(c: QueueFsCoords): string {
	return join(c.queuesRoot, c.owner, c.repo, c.workflow, `${c.queue}.ndjson`);
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: string }).code === "ENOENT"
	);
}

async function readQueueText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if (isEnoent(err)) {
			return null;
		}
		throw err;
	}
}

function parseValidLines(text: string): unknown[] {
	const out: unknown[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.length === 0) {
			continue;
		}
		try {
			out.push(JSON.parse(line));
		} catch {
			// Tolerate partial trailing line (concurrent put still in flight)
			// and any other malformed line; per the spec the inspection path
			// surfaces only valid items.
		}
	}
	return out;
}

async function listQueueItems(opts: ListOptions): Promise<ListResult> {
	const text = await readQueueText(queueFilePath(opts));
	if (text === null) {
		return { items: [], total: 0 };
	}
	const all = parseValidLines(text);
	const offset = Math.max(0, opts.offset ?? 0);
	const limit = Math.max(0, opts.limit ?? all.length);
	const items = all.slice(offset, offset + limit);
	return { items, total: all.length };
}

// LF (`\n`) — NDJSON record separator. Counted directly to avoid an O(items)
// `String.split` allocation when only the count is needed (scope-page card
// rendering).
const LF_CHAR_CODE = 0x0a;

async function countQueueItems(c: QueueFsCoords): Promise<number> {
	const text = await readQueueText(queueFilePath(c));
	if (text === null) {
		return 0;
	}
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === LF_CHAR_CODE) {
			n++;
		}
	}
	return n;
}

export type { ListOptions, ListResult, QueueFsCoords };
export { countQueueItems, listQueueItems, queueFilePath };
