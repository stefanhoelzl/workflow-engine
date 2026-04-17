// Stubs browser globals that testharness.js reads during load.
// Rollup-bundled into an IIFE string and eval'd inside the QuickJS
// sandbox BEFORE testharness.js runs.
//
// This code executes in the QuickJS guest context — Node's type env
// does not apply at runtime. We cast through `globalThis as any` for
// assignments to properties Node's types declare as readonly.

const G = globalThis as any;

// --- location stub -----------------------------------------------------
if (typeof G.location === "undefined") {
	G.location = { search: "", href: "https://web-platform.test/" };
}

// --- GLOBAL feature-detect helper --------------------------------------
// Some WPT files probe GLOBAL.isWindow() / isWorker() to pick a code path.
// We identify as a worker-ish global so Window-only branches are skipped.
G.GLOBAL = {
	isWindow: () => false,
	isWorker: () => true,
	isShadowRealm: () => false,
};

// --- DOM class stubs ---------------------------------------------------
// Some WPT battery files construct DOM classes at file scope (e.g.
// structured-clone-battery-of-tests.js calls `new Blob(...)` during eval).
// Without these, the file throws ReferenceError before any subtests
// register — and spec.ts can only file-skip. With stubs present, file
// scope loads; individual subtests can be subtest-level skipped.
// Guards let real WASM-ext classes (if later shipped) take precedence.
if (typeof G.Blob === "undefined") {
	G.Blob = class Blob {};
}
if (typeof G.File === "undefined") {
	G.File = class File extends G.Blob {};
}
if (typeof G.FileList === "undefined") {
	G.FileList = class FileList {};
}
if (typeof G.ImageData === "undefined") {
	G.ImageData = class ImageData {};
}
if (typeof G.ImageBitmap === "undefined") {
	G.ImageBitmap = class ImageBitmap {};
}
if (typeof G.MessagePort === "undefined") {
	G.MessagePort = class MessagePort {};
}
if (typeof G.ReadableStream === "undefined") {
	G.ReadableStream = class ReadableStream {};
}
if (typeof G.Response === "undefined") {
	G.Response = class Response {};
}

// --- WebAssembly.Memory SAB workaround ---------------------------------
// common/sab.js derives its SharedArrayBuffer constructor from
// new WebAssembly.Memory({shared:true}).buffer.constructor. Expose just
// enough of that path; SAB is native in quickjs-wasi.
if (typeof G.WebAssembly === "undefined") {
	G.WebAssembly = {
		Memory(opts: { shared?: boolean; initial?: number }) {
			if (!opts?.shared) {
				throw new Error("WebAssembly.Memory stub: shared:true required");
			}
			const pages = Math.trunc(opts.initial ?? 0);
			return { buffer: new SharedArrayBuffer(pages * 65_536) };
		},
	};
}

// --- __wpt shared state -------------------------------------------------
// Read by POST_HARNESS (populates .results / .completed) and ENTRY
// (flushes .results through __wptReport, awaits .completed).
G.__wpt = {
	completed: false,
	resolvers: [],
	results: [],
};

export type {};
