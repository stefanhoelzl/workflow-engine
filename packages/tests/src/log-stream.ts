import type { LogLine } from "./types.js";

interface LogStream {
	readonly lines: readonly LogLine[];
	query(predicate: (line: LogLine) => boolean): readonly LogLine[];
	waitFor(
		predicate: (line: LogLine) => boolean,
		opts?: { hardCap?: number },
	): Promise<LogLine>;
}

const DEFAULT_WAITFOR_HARDCAP_MS = 5000;
const POLL_INTERVAL_MS = 25;

// Thin reader over the spawn buffer. PR 6 ships query (sync filter) and
// waitFor (poll-and-resolve with hard cap). PR 8 will add mark()/since for
// per-test scoping; the storage shape (single shared array) stays the same.
function createLogStream(buffer: readonly LogLine[]): LogStream {
	function query(pred: (l: LogLine) => boolean): readonly LogLine[] {
		const matches: LogLine[] = [];
		for (const line of buffer) {
			if (pred(line)) {
				matches.push(line);
			}
		}
		return matches;
	}
	async function waitFor(
		pred: (l: LogLine) => boolean,
		opts?: { hardCap?: number },
	): Promise<LogLine> {
		const hardCap = opts?.hardCap ?? DEFAULT_WAITFOR_HARDCAP_MS;
		const deadline = Date.now() + hardCap;
		while (Date.now() < deadline) {
			const hit = buffer.find(pred);
			if (hit) {
				return hit;
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		throw new Error(
			`LogStream.waitFor: predicate not satisfied within ${String(hardCap)}ms`,
		);
	}
	return {
		get lines() {
			return buffer;
		},
		query,
		waitFor,
	};
}

export type { LogStream };
export { createLogStream };
