import { describe, expect, it, vi } from "vitest";
import { createRunScopedHandles } from "./run-scoped-handles.js";

describe("createRunScopedHandles", () => {
	it("track returns its argument and records the handle", async () => {
		const close = vi.fn();
		const handles = createRunScopedHandles<{ id: number }>(close);
		const h = { id: 1 };
		expect(handles.track(h)).toBe(h);
		await handles.drain();
		expect(close).toHaveBeenCalledWith(h);
	});

	it("release removes the handle and awaits close", async () => {
		const close = vi.fn(async () => {});
		const handles = createRunScopedHandles<number>(close);
		handles.track(7);
		await handles.release(7);
		expect(close).toHaveBeenCalledWith(7);
		// drain after release is a no-op
		await handles.drain();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("release on an unknown handle is a no-op", async () => {
		const close = vi.fn();
		const handles = createRunScopedHandles<string>(close);
		await handles.release("never-tracked");
		expect(close).not.toHaveBeenCalled();
	});

	it("release on an already-released handle is a no-op", async () => {
		const close = vi.fn(async () => {});
		const handles = createRunScopedHandles<string>(close);
		handles.track("a");
		await handles.release("a");
		await handles.release("a");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("drain closes every tracked handle and clears the set", async () => {
		const close = vi.fn(async () => {});
		const handles = createRunScopedHandles<number>(close);
		handles.track(1);
		handles.track(2);
		handles.track(3);
		await handles.drain();
		expect(close).toHaveBeenCalledTimes(3);
		// drain again: nothing to close
		await handles.drain();
		expect(close).toHaveBeenCalledTimes(3);
	});

	it("auto-awaits sync closers", async () => {
		const closed: number[] = [];
		const handles = createRunScopedHandles<number>((h) => {
			closed.push(h);
		});
		handles.track(42);
		await handles.release(42);
		expect(closed).toEqual([42]);
	});

	it("awaits async closers", async () => {
		const closed: number[] = [];
		const handles = createRunScopedHandles<number>(async (h) => {
			await new Promise((r) => setTimeout(r, 5));
			closed.push(h);
		});
		handles.track(11);
		await handles.release(11);
		expect(closed).toEqual([11]);
	});

	it("swallows errors thrown by the closer in release", async () => {
		const handles = createRunScopedHandles<number>(() => {
			throw new Error("boom");
		});
		handles.track(1);
		await expect(handles.release(1)).resolves.toBeUndefined();
	});

	it("swallows errors rejected by the closer in release", async () => {
		const handles = createRunScopedHandles<number>(async () => {
			throw new Error("async boom");
		});
		handles.track(1);
		await expect(handles.release(1)).resolves.toBeUndefined();
	});

	it("swallows errors thrown by the closer in drain", async () => {
		const closed: number[] = [];
		const handles = createRunScopedHandles<number>((h) => {
			if (h === 2) {
				throw new Error("boom on 2");
			}
			closed.push(h);
		});
		handles.track(1);
		handles.track(2);
		handles.track(3);
		await expect(handles.drain()).resolves.toBeUndefined();
		// 1 and 3 still get closed despite 2 throwing
		expect(closed.sort()).toEqual([1, 3]);
	});

	it("does not double-close when release races with drain", async () => {
		// Hold the closer on a deferred so we can interleave release + drain
		// while a close is in flight.
		let resolveClose: (() => void) | undefined;
		const close = vi.fn(
			() =>
				new Promise<void>((res) => {
					resolveClose = res;
				}),
		);
		const handles = createRunScopedHandles<number>(close);
		handles.track(1);
		const releasePromise = handles.release(1);
		const drainPromise = handles.drain();
		// Allow the synchronous portion of release/drain to run; the closer
		// is awaited but parked on the deferred.
		await Promise.resolve();
		// Drain must NOT have re-queued a close for handle 1, because
		// release() deleted it before awaiting close.
		expect(close).toHaveBeenCalledTimes(1);
		resolveClose?.();
		await releasePromise;
		await drainPromise;
		expect(close).toHaveBeenCalledTimes(1);
	});
});
