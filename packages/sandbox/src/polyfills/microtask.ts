// Wrap queueMicrotask so uncaught exceptions route through reportError —
// which dispatches an ErrorEvent on globalThis. Satisfies
// `html/webappapis/microtask-queuing/queue-microtask-exceptions.any.js`.

const _origQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

globalThis.queueMicrotask = (cb: () => void): void => {
	// Preserve native WebIDL TypeError for non-callable / missing callback.
	if (typeof cb !== "function") {
		// Delegate to the native implementation so the TypeError and message
		// match spec exactly (WPT probes the error's message/constructor).
		_origQueueMicrotask(cb as unknown as () => void);
		return;
	}
	_origQueueMicrotask(() => {
		try {
			cb();
		} catch (err) {
			globalThis.reportError(err);
		}
	});
};
