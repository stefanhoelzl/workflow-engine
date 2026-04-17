// Single rollup entry for virtual:sandbox-polyfills.
// ES module execution order enforces the install sequence:
//   trivial      — self, navigator (no deps)
//   event-target — EventTarget/Event/ErrorEvent/AbortController/AbortSignal
//   report-error — reportError (depends on ErrorEvent + globalThis.dispatchEvent)
//   microtask    — queueMicrotask wrap (depends on reportError)
//   fetch        — fetch shim (depends on Headers/TextEncoder from WASM ext;
//                  independent of event stack but bundled together for
//                  single-eval simplicity in worker.ts)

import "./trivial.js";
import "./event-target.js";
import "./report-error.js";
import "./microtask.js";
import "./fetch.js";
