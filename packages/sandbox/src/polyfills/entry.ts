// Single rollup entry for virtual:sandbox-polyfills.
// ES module execution order enforces the install sequence:
//   trivial          — self, navigator (no deps)
//   event-target     — EventTarget/Event/ErrorEvent/AbortController/AbortSignal
//   report-error     — reportError (depends on ErrorEvent + globalThis.dispatchEvent)
//   microtask        — queueMicrotask wrap (depends on reportError)
//   streams          — Readable/Writable/TransformStream + queuing strategies
//                      + TextEncoder/DecoderStream (ponyfill, no deps)
//   compression      — CompressionStream/DecompressionStream (WHATWG). Pure-JS
//                      TransformStream wrappers around fflate's gzip/deflate/
//                      inflate streaming classes. Depends on TransformStream.
//   fetch            — fetch shim (depends on Headers/TextEncoder from WASM ext;
//                      independent of event stack but bundled together for
//                      single-eval simplicity in worker.ts)
//   structured-clone — structuredClone override (uses native DOMException)
//   idb-domexception-fix — wraps DOMException in a construct-trap Proxy so
//                      fake-indexeddb's subclass `throw new DataError()`
//                      ends up as a plain DOMException instance (must run
//                      before indexed-db imports fake-indexeddb).
//   indexed-db       — fake-indexeddb (depends on structuredClone)
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
//   scheduler        — self.scheduler + TaskController/TaskSignal/
//                      TaskPriorityChangeEvent (scheduler-polyfill). Depends on
//                      AbortController/AbortSignal + Event from event-target,
//                      and setTimeout.
//   observable       — Observable + Subscriber + EventTarget.prototype.when
//                      (observable-polyfill). Depends on EventTarget,
//                      AbortController/AbortSignal, Promise, queueMicrotask.

import "./trivial.js";
import "./event-target.js";
import "./report-error.js";
import "./microtask.js";
import "./streams.js";
import "./compression.js";
import "./fetch.js";
import "./structured-clone.js";
import "./idb-domexception-fix.js";
import "./indexed-db.js";
import "./user-timing.js";
import "./subtle-crypto.js";
import "urlpattern-polyfill";
import "./scheduler.js";
import "./observable.js";
