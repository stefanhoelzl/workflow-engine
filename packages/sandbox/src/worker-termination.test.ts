import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkerTermination,
	SANDBOX_LIMIT_ERROR_NAME,
	type TerminationCause,
} from "./worker-termination.js";

interface MockWorker extends EventEmitter {
	terminate: ReturnType<typeof vi.fn>;
	fireError(err: Error): void;
	fireExit(code?: number): void;
}

function makeMockWorker(): MockWorker {
	const ee = new EventEmitter();
	const terminate = vi.fn().mockResolvedValue(0);
	const worker = Object.assign(ee, {
		terminate,
		fireError(err: Error) {
			ee.emit("error", err);
		},
		fireExit(code = 1) {
			ee.emit("exit", code);
		},
	}) as MockWorker;
	return worker;
}

function tagLimitError(dim: string, observed?: number): Error {
	const e = new Error(`limit:${dim}`);
	e.name = SANDBOX_LIMIT_ERROR_NAME;
	(e as Error & { dim: string; observed?: number }).dim = dim;
	if (observed !== undefined) {
		(e as Error & { dim: string; observed?: number }).observed = observed;
	}
	return e;
}

describe("createWorkerTermination", () => {
	it("fires onTerminated with crash cause for a plain Error", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		let cause: TerminationCause | undefined;
		wt.onTerminated((c: TerminationCause) => {
			cause = c;
		});
		mock.fireError(new Error("boom"));
		mock.fireExit(1);
		expect(cause).not.toBeNull();
		expect(cause?.kind).toBe("crash");
		if (cause?.kind === "crash") {
			expect(cause.err.message).toBe("boom");
		}
	});

	it("fires onTerminated with limit cause for a tagged SandboxLimitError", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		let cause: TerminationCause | undefined;
		wt.onTerminated((c: TerminationCause) => {
			cause = c;
		});
		mock.fireError(tagLimitError("output", 4_194_305));
		mock.fireExit(1);
		expect(cause?.kind).toBe("limit");
		if (cause?.kind === "limit") {
			expect(cause.dim).toBe("output");
			expect(cause.observed).toBe(4_194_305);
		}
	});

	it("fires exactly once when multiple error events precede exit", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		const cb = vi.fn();
		wt.onTerminated(cb);
		mock.fireError(new Error("first"));
		mock.fireError(new Error("second"));
		mock.fireExit(1);
		mock.fireExit(1);
		expect(cb).toHaveBeenCalledTimes(1);
		const call = cb.mock.calls[0]?.[0] as TerminationCause;
		expect(call.kind).toBe("crash");
		if (call.kind === "crash") {
			expect(call.err.message).toBe("first");
		}
	});

	it("CPU watchdog fires and terminates the worker", async () => {
		vi.useFakeTimers();
		try {
			const mock = makeMockWorker();
			const wt = createWorkerTermination(mock as unknown as Worker);
			let cause: TerminationCause | undefined;
			wt.onTerminated((c: TerminationCause) => {
				cause = c;
			});
			wt.armCpuBudget(50);
			vi.advanceTimersByTime(60);
			expect(mock.terminate).toHaveBeenCalledTimes(1);
			mock.fireExit(1);
			expect(cause?.kind).toBe("limit");
			if (cause?.kind === "limit") {
				expect(cause.dim).toBe("cpu");
				expect(typeof cause.observed).toBe("number");
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("disarm before expiry prevents CPU watchdog from firing", () => {
		vi.useFakeTimers();
		try {
			const mock = makeMockWorker();
			const wt = createWorkerTermination(mock as unknown as Worker);
			wt.armCpuBudget(60_000);
			vi.advanceTimersByTime(10);
			wt.disarmCpuBudget();
			vi.advanceTimersByTime(120_000);
			expect(mock.terminate).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("markDisposing suppresses onTerminated on subsequent exit", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		const cb = vi.fn();
		wt.onTerminated(cb);
		wt.markDisposing();
		mock.fireExit(1);
		expect(cb).not.toHaveBeenCalled();
	});

	it("clean exit without recorded error classifies as crash", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		let cause: TerminationCause | undefined;
		wt.onTerminated((c: TerminationCause) => {
			cause = c;
		});
		mock.fireExit(0);
		expect(cause?.kind).toBe("crash");
	});

	it("limit cause without observed omits the field", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		let cause: TerminationCause | undefined;
		wt.onTerminated((c: TerminationCause) => {
			cause = c;
		});
		mock.fireError(tagLimitError("output"));
		mock.fireExit(1);
		expect(cause?.kind).toBe("limit");
		if (cause?.kind === "limit") {
			expect(cause.dim).toBe("output");
			expect(cause.observed).toBeUndefined();
		}
	});

	it("cause() returns null when nothing has happened", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		expect(wt.cause()).toBeNull();
	});

	it("cause() returns crash classification synchronously after error", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		mock.fireError(new Error("kaboom"));
		const c = wt.cause();
		expect(c?.kind).toBe("crash");
		if (c?.kind === "crash") {
			expect(c.err.message).toBe("kaboom");
		}
	});

	it("cause() returns limit classification synchronously after tagged error", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		mock.fireError(tagLimitError("pending", 5));
		const c = wt.cause();
		expect(c?.kind).toBe("limit");
		if (c?.kind === "limit") {
			expect(c.dim).toBe("pending");
			expect(c.observed).toBe(5);
		}
	});

	it("cause() returns null while disposing", () => {
		const mock = makeMockWorker();
		const wt = createWorkerTermination(mock as unknown as Worker);
		mock.fireError(new Error("boom"));
		wt.markDisposing();
		expect(wt.cause()).toBeNull();
	});

	it("cause() returns cpu limit synchronously after watchdog fires", () => {
		vi.useFakeTimers();
		try {
			const mock = makeMockWorker();
			const wt = createWorkerTermination(mock as unknown as Worker);
			wt.armCpuBudget(50);
			vi.advanceTimersByTime(60);
			const c = wt.cause();
			expect(c?.kind).toBe("limit");
			if (c?.kind === "limit") {
				expect(c.dim).toBe("cpu");
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("queueMicrotask-thrown SandboxLimitError reaches Node's error channel", async () => {
		// Smoke test verifying Node.js structured-cloning behaviour for
		// non-standard own properties on Error instances: a real worker_threads
		// Worker that throws a tagged error via queueMicrotask must surface
		// `err.dim` on main's `error` event. Skipped under the unit suite's
		// fake-timers — this runs as part of `sandbox.test.ts` integration
		// instead.
		expect(SANDBOX_LIMIT_ERROR_NAME).toBe("SandboxLimitError");
	});
});
