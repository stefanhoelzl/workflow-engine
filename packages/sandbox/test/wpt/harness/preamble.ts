// Source strings evaluated at specific points inside the WPT sandbox.
// The composer orders them:
//   PREAMBLE + testharness.js + POST_HARNESS + deps + file + ENTRY
//
// PREAMBLE  — stubs browser globals testharness.js expects (self, location,
//             GLOBAL, addEventListener)
// POST_HARNESS — registers add_result_callback + add_completion_callback
//             BEFORE any test file runs. Sync test() calls in test files
//             can trigger notify_complete during eval, and testharness does
//             not re-fire callbacks registered after that, so we have to
//             register up front. Callbacks collect results into a shared
//             array and set a "completed" flag.
// ENTRY     — defines __wptEntry, a function returning a Promise that
//             resolves when the completed flag is set (or immediately if
//             already set by sync test completion during eval).

const PREAMBLE = `(function() {
  if (typeof location === 'undefined') {
    globalThis.location = { search: '', href: 'https://web-platform.test/' };
  }
  globalThis.GLOBAL = {
    isWindow: function() { return false; },
    isWorker: function() { return true; },
    isShadowRealm: function() { return false; },
  };
  // (addEventListener/removeEventListener/dispatchEvent are now provided by
  // the sandbox EventTarget polyfill; no stubs needed here.)
  // Non-throwing stubs for DOM classes that some WPT battery files construct
  // at file scope (e.g. structured-clone-battery-of-tests.js line 339:
  // check('Array Blob object, Blob basic', [func_Blob_basic()], ...) calls
  // new Blob(...) during eval). Without these, the file throws a
  // ReferenceError before any subtests register, and spec.ts can only
  // file-skip. With the stubs present, file scope loads; the individual
  // subtests fail at assertion time and are skipped by name in spec.ts.
  // Guards let real WASM-ext classes (if later shipped) take precedence.
  if (typeof Blob === 'undefined') globalThis.Blob = class Blob {};
  if (typeof File === 'undefined') globalThis.File = class File extends globalThis.Blob {};
  if (typeof FileList === 'undefined') globalThis.FileList = class FileList {};
  if (typeof ImageData === 'undefined') globalThis.ImageData = class ImageData {};
  if (typeof ImageBitmap === 'undefined') globalThis.ImageBitmap = class ImageBitmap {};
  if (typeof MessagePort === 'undefined') globalThis.MessagePort = class MessagePort {};
  if (typeof ReadableStream === 'undefined') globalThis.ReadableStream = class ReadableStream {};
  if (typeof Response === 'undefined') globalThis.Response = class Response {};
  // common/sab.js derives its SharedArrayBuffer constructor from
  // new WebAssembly.Memory({shared:true}).buffer.constructor. Expose just
  // enough of that path; SAB is native in quickjs-wasi.
  if (typeof globalThis.WebAssembly === 'undefined') {
    globalThis.WebAssembly = {
      Memory: function(opts) {
        if (!opts || !opts.shared) {
          throw new Error('WebAssembly.Memory stub: shared:true required');
        }
        var pages = (opts.initial | 0);
        return { buffer: new SharedArrayBuffer(pages * 65536) };
      },
    };
  }
  // Shared state read by POST_HARNESS + ENTRY.
  globalThis.__wpt = {
    completed: false,
    resolvers: [],
    results: [],
  };
})();`;

const POST_HARNESS = `(function() {
  function statusName(s) {
    if (s === 0) return 'PASS';
    if (s === 1) return 'FAIL';
    if (s === 2) return 'TIMEOUT';
    if (s === 3) return 'NOTRUN';
    if (s === 4) return 'PRECONDITION_FAILED';
    return 'UNKNOWN';
  }
  // Buffer results into an in-VM array. Sync test() calls fire
  // add_result_callback DURING sandbox init eval; at that point __wptReport
  // (a per-run extraMethod) isn't installed yet. We buffer now and flush in
  // __wptEntry, which runs at sandbox.run() time when __wptReport is live.
  add_result_callback(function(test) {
    try {
      globalThis.__wpt.results.push({
        name: String(test.name),
        status: statusName(test.status),
        message: test.message == null ? '' : String(test.message),
      });
    } catch (e) { /* swallow */ }
  });
  add_completion_callback(function() {
    globalThis.__wpt.completed = true;
    var resolvers = globalThis.__wpt.resolvers;
    globalThis.__wpt.resolvers = [];
    for (var i = 0; i < resolvers.length; i++) {
      try { resolvers[i](); } catch (e) { /* swallow */ }
    }
  });
})();`;

const ENTRY = `(function() {
  globalThis.__wptEntry = async function() {
    // Force microtask drain (ShellTestEnvironment sets all_loaded after a
    // microtask), then call done() to trigger end_wait → complete →
    // add_completion_callback. No-op for files that already completed.
    try {
      await Promise.resolve();
      if (typeof done === 'function') done();
    } catch (e) { /* swallow */ }
    if (!globalThis.__wpt.completed) {
      await new Promise(function(resolve) {
        globalThis.__wpt.resolvers.push(function() { resolve(undefined); });
      });
    }
    // Flush buffered results through the per-run __wptReport bridge.
    var results = globalThis.__wpt.results;
    globalThis.__wpt.results = [];
    for (var i = 0; i < results.length; i++) {
      try {
        __wptReport(results[i].name, results[i].status, results[i].message);
      } catch (e) { /* swallow */ }
    }
    return undefined;
  };
})();`;

export { ENTRY, POST_HARNESS, PREAMBLE };
