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
//   blob             — Blob, File from fetch-blob@4 (depends on streams; the
//                      vite plugin strips fetch-blob's TLA Node fallback —
//                      ReadableStream is provided by streams above)
//   form-data        — FormData from formdata-polyfill@4 (depends on Blob/File
//                      via fetch-blob v3 transitive; v3's CJS Node prelude is
//                      try/catch'd at runtime and is a no-op once
//                      globalThis.ReadableStream is present)
//   response         — hand-rolled WHATWG Response (depends on body-mixin)
//   request          — hand-rolled WHATWG Request (depends on body-mixin)
//   fetch            — fetch shim wrapping __hostFetch; accepts Request input
//                      and returns a real Response (depends on response/request)
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
import "./blob.js";
import "./form-data.js";
import "./response.js";
import "./request.js";
import "./fetch.js";
import "./structured-clone.js";
import "./idb-domexception-fix.js";
import "./indexed-db.js";
import "./user-timing.js";
import "./subtle-crypto.js";
import "urlpattern-polyfill";
import "./scheduler.js";
import "./observable.js";
