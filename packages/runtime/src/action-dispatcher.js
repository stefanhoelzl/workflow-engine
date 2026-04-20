// Action-dispatcher IIFE appended to every workflow bundle source before
// sandbox construction. Captures `__hostCallAction` + `__emitEvent` into
// closure locals, installs `__dispatchAction` as a locked global, and deletes
// the two bridge names from globalThis so guest code cannot read or overwrite
// them. See SECURITY.md §2.
//
// The SDK (as of the bake-action-names-drop-trigger-shim change) bakes
// action names into the bundle at build time and exports trigger callables
// directly — no `__trigger_<name>` shim and no `__setActionName` binder are
// needed anymore, so this dispatcher is the only source the runtime appends.

(function () {
	var _hostCall = globalThis.__hostCallAction;
	var _emit = globalThis.__emitEvent;
	async function dispatch(name, input, handler, outputSchema) {
		_emit({ kind: "action.request", name, input });
		try {
			await _hostCall(name, input);
			const raw = await handler(input);
			const output = outputSchema.parse(raw);
			_emit({ kind: "action.response", name, output });
			return output;
		} catch (err) {
			const error = {
				message: err && err.message ? String(err.message) : String(err),
				stack: err && err.stack ? String(err.stack) : "",
			};
			if (err && err.issues !== undefined) error.issues = err.issues;
			_emit({ kind: "action.error", name, error });
			throw err;
		}
	}
	Object.defineProperty(globalThis, "__dispatchAction", {
		value: dispatch,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	delete globalThis.__hostCallAction;
	delete globalThis.__emitEvent;
})();
