// Run-scoped handle tracker for stdlib plugins that allocate per-call host
// resources (mail Transport, sql connection, fetch AbortController). Plugins
// `track` a handle on acquisition, `release` it from the per-call `finally`,
// and wire `onRunFinished: handles.drain` so any handle that escaped the
// per-call path (guest fired-and-forgot the host call) is closed at run end.
//
// Why this exists: the Node worker thread persists across QuickJS snapshot-
// restores. An in-flight host-call promise from run N can resolve during
// run N+1's worker-time window — the per-call `finally` still eventually
// fires, but the resource lives across the run boundary. Per SECURITY.md
// R-4, plugins with per-call host resources need an `onRunFinished` backstop.
//
// Audit-event mis-tagging is NOT a concern: the worker-side
// `bridge.clearRunActive()` gate (packages/sandbox/src/worker.ts) suppresses
// late host-callback emissions at the source, and the main-thread
// RunSequencer synthesizes close frames for any dangling open frames using
// the current run's stamping. The backstop's job is resource-lifetime
// determinism and worker-time fairness, not audit correctness.

interface RunScopedHandles<T> {
	track(handle: T): T;
	release(handle: T): Promise<void>;
	drain(): Promise<void>;
}

function createRunScopedHandles<T>(
	close: (handle: T) => Promise<void> | void,
): RunScopedHandles<T> {
	const open = new Set<T>();

	async function safeClose(handle: T): Promise<void> {
		try {
			await close(handle);
		} catch {
			// Closer errors are swallowed: a hung-socket cleanup must never
			// fail the run, and run-end drain must complete every handle.
		}
	}

	return {
		track(handle: T): T {
			open.add(handle);
			return handle;
		},
		async release(handle: T): Promise<void> {
			// Delete BEFORE awaiting close so a concurrent drain() racing
			// with release() never processes the same handle twice. Closers
			// are idempotent in every current caller (nodemailer
			// SMTPTransport.close, postgres.end, AbortController.abort) but
			// the delete-before-close ordering removes any race regardless.
			if (!open.delete(handle)) {
				return;
			}
			await safeClose(handle);
		},
		async drain(): Promise<void> {
			const snapshot = [...open];
			open.clear();
			await Promise.allSettled(snapshot.map((h) => safeClose(h)));
		},
	};
}

export type { RunScopedHandles };
export { createRunScopedHandles };
