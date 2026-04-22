// WinterCG MCA trivial shims — self identity + frozen navigator.
// No host capability; see SECURITY.md §2.

(globalThis as unknown as { self: typeof globalThis }).self = globalThis;

Object.defineProperty(globalThis, "navigator", {
	value: Object.freeze({
		userAgent: "WorkflowEngine",
	}),
	writable: false,
	configurable: false,
	enumerable: true,
});
