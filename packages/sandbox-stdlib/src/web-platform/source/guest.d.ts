// Ambient declarations for guest-side polyfill sources. The __*-prefixed
// host bridges (__reportError, __hostFetch) are intentionally NOT declared
// here: they are captured via property lookup on globalThis and then
// deleted (capture-and-delete per CLAUDE.md §2). Accessing them through
// `globalThis.__reportError` with narrow inline typing keeps the closure
// capture explicit at the call site.

declare global {
	const __WFE_VERSION__: string;
}

export {};
