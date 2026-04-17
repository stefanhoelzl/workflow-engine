// WinterCG MCA trivial shims — self identity + frozen navigator.
// `__WFE_VERSION__` is replaced at rollup-bundle time with the sandbox
// package version. No host capability; see SECURITY.md §2.

(globalThis as unknown as { self: typeof globalThis }).self = globalThis;

Object.defineProperty(globalThis, "navigator", {
	value: Object.freeze({
		userAgent: `WorkflowEngine/${__WFE_VERSION__}`,
	}),
	writable: false,
	configurable: false,
	enumerable: true,
});
