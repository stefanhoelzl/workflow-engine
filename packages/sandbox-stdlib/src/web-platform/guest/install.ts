// Guest-side installer module. Importing this file for its side effects
// (transitively via `./entry.js`) installs every web-platform polyfill in
// the documented order. The `?sandbox-plugin` vite transform bundles this
// file together with its `guest()` caller so the IIFE that evaluates inside
// QuickJS at Phase 2 carries every polyfill inlined.
//
// ES module semantics guarantee each side-effect import runs exactly once
// at bundle load; `install()` is the explicit call site `guest()` invokes
// so tree-shakers keep this module (and therefore its side-effect imports)
// alive.

import "./entry.js";

export function install(): void {
	// Intentional no-op body. The install happens above via
	// `import "./entry.js"`; keeping `install()` exported and invoked from
	// `guest()` signals to the bundler that this module is reachable.
}
