import type { LogLine } from "./types.js";

// Opaque per-test marker. The integer encodes the buffer index at the
// moment `mark()` was called; consumers MUST treat it as opaque.
type Marker = number & { readonly __brand: "log-stream-marker" };

interface LogStream {
	readonly lines: readonly LogLine[];
	mark(): Marker;
	since(marker: Marker): readonly LogLine[];
	query(
		predicate: (line: LogLine) => boolean,
		opts?: { since?: Marker },
	): readonly LogLine[];
	assertNotPresent(value: string, opts?: { since?: Marker }): void;
	waitFor(
		predicate: (line: LogLine) => boolean,
		opts?: { hardCap?: number; since?: Marker },
	): Promise<LogLine>;
}

const DEFAULT_WAITFOR_HARDCAP_MS = 5000;
const POLL_INTERVAL_MS = 25;

// Thin reader over the spawn buffer. PR 6 shipped query + waitFor; PR 8
// adds mark()/since for per-test scoping plus assertNotPresent for the
// sealed-secret redaction assertion.
function createLogStream(buffer: readonly LogLine[]): LogStream {
	function mark(): Marker {
		return buffer.length as Marker;
	}
	function sliceFrom(marker: Marker | undefined): readonly LogLine[] {
		if (marker === undefined) {
			return buffer;
		}
		return buffer.slice(marker);
	}
	function since(marker: Marker): readonly LogLine[] {
		return sliceFrom(marker);
	}
	function query(
		pred: (l: LogLine) => boolean,
		opts?: { since?: Marker },
	): readonly LogLine[] {
		const slice = sliceFrom(opts?.since);
		const matches: LogLine[] = [];
		for (const line of slice) {
			if (pred(line)) {
				matches.push(line);
			}
		}
		return matches;
	}
	function assertNotPresent(value: string, opts?: { since?: Marker }): void {
		if (value === "") {
			throw new Error(
				"LogStream.assertNotPresent: refusing to scan for empty string",
			);
		}
		const slice = sliceFrom(opts?.since);
		for (const line of slice) {
			if (JSON.stringify(line).includes(value)) {
				throw new Error(
					`LogStream.assertNotPresent: value found in log line: ${JSON.stringify(line)}`,
				);
			}
		}
	}
	async function waitFor(
		pred: (l: LogLine) => boolean,
		opts?: { hardCap?: number; since?: Marker },
	): Promise<LogLine> {
		const hardCap = opts?.hardCap ?? DEFAULT_WAITFOR_HARDCAP_MS;
		const deadline = Date.now() + hardCap;
		while (Date.now() < deadline) {
			const slice = sliceFrom(opts?.since);
			const hit = slice.find(pred);
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
		mark,
		since,
		query,
		assertNotPresent,
		waitFor,
	};
}

export type { LogStream, Marker };
export { createLogStream };
