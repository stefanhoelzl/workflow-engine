// Single rollup entry for virtual:sandbox-polyfills.
//
// core-js (targeted) — runs first so feature-detected ES polyfills are in
// place before any web-platform shim or the user's workflow code observes
// `globalThis`. Imports are TARGETED, never the `core-js/stable` aggregate:
// the aggregate pulls in `core-js/stable/url`, `…/url-search-params`,
// `…/url-pattern`, `…/dom-exception`, `…/structured-clone`, and `…/self`,
// each of which OVERWRITES the (more conformant) WASM-ext / urlpattern-
// polyfill / hand-rolled implementations and regresses ~98 WPT subtests.
// The picks below cover ES-only language additions (Iterator helpers,
// new Set methods, Promise.withResolvers, Object.groupBy, Map.groupBy,
// Array.fromAsync, ArrayBuffer.prototype.transfer) where core-js is
// strictly additive and does not collide with any web-platform shim.
//
// Hand-rolled URL.prototype.searchParams patch (./url.js) runs AFTER the
// core-js block but BEFORE the web-platform chain so that streams/fetch/
// request/response shims see the live two-way bound accessor.
//
// ES module execution order then enforces the web-platform install sequence:
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

// core-js targeted polyfills — feature-detected, ES-only. See header comment.
import "core-js/stable/iterator";
import "core-js/stable/set";
import "core-js/stable/promise/with-resolvers";
import "core-js/stable/object/group-by";
import "core-js/stable/map/group-by";
import "core-js/stable/array/from-async";
import "core-js/stable/array-buffer/transfer";

// Hand-rolled URL.prototype.searchParams live two-way bound accessor.
// MUST run after core-js (so iterator helpers are in place) and BEFORE the
// web-platform chain (streams/fetch/request/response construct URLs).
import "./url.js";

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
