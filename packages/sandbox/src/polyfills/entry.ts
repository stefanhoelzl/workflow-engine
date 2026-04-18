// Single rollup entry for virtual:sandbox-polyfills.
// ES module execution order enforces the install sequence:
//   trivial          — self, navigator (no deps)
//   event-target     — EventTarget/Event/ErrorEvent/AbortController/AbortSignal
//   report-error     — reportError (depends on ErrorEvent + globalThis.dispatchEvent)
//   microtask        — queueMicrotask wrap (depends on reportError)
//   fetch            — fetch shim (depends on Headers/TextEncoder from WASM ext;
//                      independent of event stack but bundled together for
//                      single-eval simplicity in worker.ts)
//   structured-clone — structuredClone override (uses native DOMException)
//   user-timing      — performance.mark/measure + PerformanceEntry classes
//                      (depends on structuredClone + DOMException)
//   subtle-crypto    — validation + DOMException translation wrapper around
//                      the native crypto.subtle from quickjs-wasi's
//                      cryptoExtension; also promise-wraps the synchronous
//                      native methods.
//   urlpattern       — URLPattern (WinterCG MCA). Self-installs via the polyfill
//                      package's own index.js: `if (!globalThis.URLPattern)
//                      globalThis.URLPattern = URLPattern`. No host capability;
//                      see SECURITY.md §2.

import "./trivial.js";
import "./event-target.js";
import "./report-error.js";
import "./microtask.js";
import "./fetch.js";
import "./structured-clone.js";
import "./user-timing.js";
import "./subtle-crypto.js";
import "urlpattern-polyfill";
