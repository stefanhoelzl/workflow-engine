import { describe, expect, it } from "vitest";
import type { Logger } from "./logger.js";
import type { WireEvent } from "./protocol.js";
import { createRunSequencer, synthCloseKind } from "./run-sequencer.js";

interface LoggerCall {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly message: string;
	readonly meta?: Record<string, unknown>;
}

function createCapturingLogger(): {
	logger: Logger;
	calls: LoggerCall[];
} {
	const calls: LoggerCall[] = [];
	const logger: Logger = {
		debug(message, meta) {
			calls.push({ level: "debug", message, ...(meta ? { meta } : {}) });
		},
		info(message, meta) {
			calls.push({ level: "info", message, ...(meta ? { meta } : {}) });
		},
		warn(message, meta) {
			calls.push({ level: "warn", message, ...(meta ? { meta } : {}) });
		},
		error(message, meta) {
			calls.push({ level: "error", message, ...(meta ? { meta } : {}) });
		},
	};
	return { logger, calls };
}

const DEFAULT_AT = "2025-01-01T00:00:00.000Z";

function leaf(kind: string, name: string, ts = 0): WireEvent {
	return { kind, name, ts, at: DEFAULT_AT, type: "leaf" };
}

function open(kind: string, name: string, callId: number, ts = 0): WireEvent {
	return { kind, name, ts, at: DEFAULT_AT, type: { open: callId } };
}

function close(kind: string, name: string, callId: number, ts = 0): WireEvent {
	return { kind, name, ts, at: DEFAULT_AT, type: { close: callId } };
}

describe("synthCloseKind — prefix-extraction synthesis kind", () => {
	it("rewrites system.request → system.error", () => {
		expect(synthCloseKind("system.request")).toBe("system.error");
	});

	it("rewrites trigger.request → trigger.error", () => {
		expect(synthCloseKind("trigger.request")).toBe("trigger.error");
	});

	it("handles typo'd suffix by extracting prefix", () => {
		expect(synthCloseKind("trigger.requestt")).toBe("trigger.error");
	});

	it("uses first dot only for multi-segment kinds", () => {
		expect(synthCloseKind("system.foo.bar")).toBe("system.error");
	});

	it("appends .error when kind has no dot", () => {
		expect(synthCloseKind("weird-no-dot")).toBe("weird-no-dot.error");
	});
});

describe("RunSequencer.next — leaf events", () => {
	it("stamps seq monotonically and ref=null when stack empty", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		const a = seq.next(leaf("system.call", "console.log"));
		const b = seq.next(leaf("system.call", "console.log"));
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a?.seq).toBe(0);
		expect(a?.ref).toBeNull();
		expect(b?.seq).toBe(1);
		expect(b?.ref).toBeNull();
	});

	it("stamps ref to current refStack top when leaf emitted under an open", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		const o = seq.next(open("trigger.request", "demo", 1));
		const l = seq.next(leaf("system.call", "console.log"));
		expect(o?.seq).toBe(0);
		expect(o?.ref).toBeNull();
		expect(l?.seq).toBe(1);
		expect(l?.ref).toBe(0);
	});
});

describe("RunSequencer.next — open/close pairing via callId", () => {
	it("pairs a close to its open via callId — LIFO case", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		const o = seq.next(open("trigger.request", "demo", 42));
		const c = seq.next(close("trigger.response", "demo", 42));
		expect(o?.seq).toBe(0);
		expect(c?.seq).toBe(1);
		expect(c?.ref).toBe(0);
	});

	it("pairs concurrent closes correctly via callId — Promise.all shape", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		const trigger = seq.next(open("trigger.request", "demo", 1));
		const a = seq.next(open("system.request", "fetchA", 2));
		const b = seq.next(open("system.request", "fetchB", 3));
		// B closes BEFORE A (network race)
		const bClose = seq.next(close("system.response", "fetchB", 3));
		const aClose = seq.next(close("system.response", "fetchA", 2));
		const triggerClose = seq.next(close("trigger.response", "demo", 1));

		expect(trigger?.seq).toBe(0);
		expect(trigger?.ref).toBeNull();
		expect(a?.seq).toBe(1);
		expect(a?.ref).toBe(0);
		// Pre-existing Promise.all parent-attribution behaviour (design.md
		// non-goal): sibling open B reads refStack-top=A, so b.ref=1 even
		// though both fetches are logically siblings under trigger.
		// The refactor preserves this; fixing it is out of scope.
		expect(b?.seq).toBe(2);
		expect(b?.ref).toBe(1);
		// Critical (this IS what the refactor fixes): close-side ref
		// attribution is correct via callId, regardless of stack order.
		// B closes BEFORE A but pairs to its own open, not the stack top.
		expect(bClose?.seq).toBe(3);
		expect(bClose?.ref).toBe(2);
		expect(aClose?.seq).toBe(4);
		expect(aClose?.ref).toBe(1);
		expect(triggerClose?.seq).toBe(5);
		expect(triggerClose?.ref).toBe(0);
	});

	it("non-conventional kinds frame correctly because framing reads type, not kind", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		// `kind` is "user.click" — does NOT end in .request, but type:{open}
		// makes it an open regardless.
		const o = seq.next(open("user.click", "btn", 7));
		const l = seq.next(leaf("system.call", "console.log"));
		expect(o?.seq).toBe(0);
		expect(o?.ref).toBeNull();
		// Leaf nests under the user.click open via refStack.
		expect(l?.ref).toBe(0);
	});

	it("treats kind ending in .request with type:leaf as a leaf", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		const e = seq.next(leaf("trigger.request", "demo"));
		expect(e?.seq).toBe(0);
		expect(e?.ref).toBeNull();
		// Subsequent event should NOT see this as an open frame.
		const next = seq.next(leaf("system.call", "x"));
		expect(next?.ref).toBeNull();
	});
});

describe("RunSequencer.next — close without matching open", () => {
	it("logs sandbox.close_without_open and returns null", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		const dropped = seq.next(close("system.response", "fetch", 999));
		expect(dropped).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.level).toBe("warn");
		expect(calls[0]?.message).toBe("sandbox.close_without_open");
		expect(calls[0]?.meta).toMatchObject({ callId: 999 });
	});
});

describe("RunSequencer.next — out-of-window events", () => {
	it("logs sandbox.event_outside_run before start()", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		const dropped = seq.next(leaf("system.call", "console.log"));
		expect(dropped).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.level).toBe("warn");
		expect(calls[0]?.message).toBe("sandbox.event_outside_run");
	});

	it("logs sandbox.event_outside_run after finish()", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(leaf("system.call", "x"));
		seq.finish();
		const dropped = seq.next(leaf("system.call", "late"));
		expect(dropped).toBeNull();
		const outOfRun = calls.filter(
			(c) => c.message === "sandbox.event_outside_run",
		);
		expect(outOfRun).toHaveLength(1);
	});
});

describe("RunSequencer.finish — death-path synthesis", () => {
	it("synthesises closes LIFO with prefix-derived kinds", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		// Inline event construction to control `at` independently.
		seq.next({
			kind: "trigger.request",
			name: "demo",
			ts: 100,
			at: "T1",
			type: { open: 1 },
		});
		seq.next({
			kind: "system.request",
			name: "fetchB",
			ts: 200,
			at: "T2",
			type: { open: 2 },
		});
		// Worker dies; both frames still open.
		const synth = seq.finish({ closeReason: "worker terminated" });

		expect(synth).toHaveLength(2);
		// LIFO: deepest first (system.request opened second, closes first).
		expect(synth[0]?.kind).toBe("system.error");
		expect(synth[0]?.name).toBe("fetchB");
		expect(synth[0]?.ref).toBe(1); // openSeq of system.request was 1
		expect(synth[0]?.error?.message).toBe("worker terminated");
		expect(synth[0]?.ts).toBe(200); // last seen
		expect(synth[0]?.at).toBe("T2");

		expect(synth[1]?.kind).toBe("trigger.error");
		expect(synth[1]?.name).toBe("demo");
		expect(synth[1]?.ref).toBe(0);

		// seq is monotonic across the synthetic sequence.
		expect(synth[0]?.seq).toBe(2);
		expect(synth[1]?.seq).toBe(3);
	});

	it("emits no events when nothing was open", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(open("trigger.request", "demo", 1));
		seq.next(close("trigger.response", "demo", 1));
		const synth = seq.finish({ closeReason: "shouldnt fire" });
		expect(synth).toHaveLength(0);
		expect(
			calls.filter((c) => c.message === "sandbox.dangling_frame"),
		).toHaveLength(0);
	});

	it("synthesises with prefix rewrite for non-conventional opener kind", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(open("user.click", "btn", 1));
		const synth = seq.finish({ closeReason: "boom" });
		expect(synth).toHaveLength(1);
		expect(synth[0]?.kind).toBe("user.error");
	});
});

describe("RunSequencer.finish — clean-end path", () => {
	it("warns sandbox.dangling_frame when frames open without closeReason", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(open("trigger.request", "demo", 1));
		const synth = seq.finish();
		expect(synth).toHaveLength(0);
		const warnings = calls.filter(
			(c) => c.message === "sandbox.dangling_frame",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.meta).toMatchObject({ count: 1 });
	});

	it("does not warn when no frames are open", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(leaf("system.call", "x"));
		seq.finish();
		expect(
			calls.filter((c) => c.message === "sandbox.dangling_frame"),
		).toHaveLength(0);
	});
});

describe("RunSequencer lifecycle — across runs", () => {
	it("zeroes state at finish, supports a fresh start()", () => {
		const { logger } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(open("trigger.request", "demo", 1));
		seq.next(close("trigger.response", "demo", 1));
		seq.finish();

		seq.start();
		const e = seq.next(leaf("system.call", "x"));
		// seq resets to 0 at run start.
		expect(e?.seq).toBe(0);
		expect(e?.ref).toBeNull();
	});

	it("warns dirty-start if finish() was skipped before next start()", () => {
		const { logger, calls } = createCapturingLogger();
		const seq = createRunSequencer(logger);
		seq.start();
		seq.next(leaf("system.call", "x"));
		// SKIP finish — simulating a programming error.
		seq.start();
		const dirty = calls.filter(
			(c) => c.message === "sandbox.sequencer_dirty_start",
		);
		expect(dirty).toHaveLength(1);
	});
});
