import type { Expectation } from "./harness/match.js";

// The flat map of WPT test classifications. Keys are glob patterns or
// file:subtest strings. Values are pass/skip with a reason. Most specific
// match wins; severity (skip > pass) breaks ties. See design.md §6.
//
// Every `reason` that names a polyfill uses the convention
// `"needs <X> polyfill"` — `grep "needs .* polyfill" spec.ts` reconstructs
// the polyfill backlog.

const spec: Record<string, Expectation> = {
	// --- Catchall baseline ---
	// Any test not otherwise matched is "unclassified" and shows as skipped
	// in the vitest report. New upstream tests appearing in a scanned dir
	// with no narrower pattern land here.
	"**": { expected: "skip", reason: "not yet classified" },

	// --- Tier-1: shipped APIs, expected to pass ---
	// First-run narrow baseline. Several dirs are triage-pending:
	// - url/** and fetch/api/** rely on fetch-to-local-file for test vectors
	//   and on Request/Response classes not yet shipped.
	// - WebCryptoAPI/** relies on fetch-to-local-file for test vectors.
	// - encoding/** has legacy encoding support gaps in the WASM extension
	//   (gb18030, iso-2022-jp, replacement encodings, etc.).
	// Each gets a narrower sub-pattern `pass` for files we know work; rest
	// stay skipped. Revisit in follow-up rounds as harness/polyfills land.
	"html/webappapis/timers/**": { expected: "pass" },
	"html/webappapis/structured-clone/**": { expected: "pass" },
	"html/webappapis/atob/**": { expected: "pass" },
	"encoding/api-basics.any.js": { expected: "pass" },
	"encoding/api-invalid-label.any.js": { expected: "pass" },
	"encoding/api-replacement-encodings.any.js": { expected: "pass" },
	"encoding/api-surrogates-utf8.any.js": { expected: "pass" },
	"encoding/encodeInto.any.js": { expected: "pass" },
	"encoding/textdecoder-arguments.any.js": { expected: "pass" },
	"encoding/textdecoder-byte-order-marks.any.js": { expected: "pass" },
	"encoding/textdecoder-copy.any.js": { expected: "pass" },
	"encoding/textdecoder-fatal.any.js": { expected: "pass" },
	"encoding/textdecoder-fatal-streaming.any.js": { expected: "pass" },
	"encoding/textdecoder-ignorebom.any.js": { expected: "pass" },
	"encoding/textdecoder-streaming.any.js": { expected: "pass" },
	"encoding/textdecoder-utf16-surrogates.any.js": { expected: "pass" },
	"encoding/textencoder-utf16-surrogates.any.js": { expected: "pass" },
	// Remaining encoding files — each blocked by a distinct gap.
	"encoding/textdecoder-eof.any.js": {
		expected: "skip",
		reason: "needs wasm-ext Big5 (inline Big5 TextDecoder in both subtests)",
	},
	"encoding/textdecoder-labels.any.js": {
		expected: "skip",
		reason: "needs wasm-ext legacy encoders (iterates every WHATWG label)",
	},
	"encoding/textdecoder-mistakes.any.js": {
		expected: "skip",
		reason:
			"needs wasm-ext legacy encoders (majority of subtests reference windows-*, gbk, gb18030, big5, shift_jis, euc-*, iso-2022-jp, koi8-*, iso-8859-*, macintosh, x-mac-cyrillic, x-user-defined)",
	},
	"encoding/textencoder-constructor-non-utf.any.js": {
		expected: "skip",
		reason: "needs wasm-ext legacy decoders (iterates every WHATWG encoding)",
	},
	"encoding/textdecoder-fatal-single-byte.any.js": {
		expected: "skip",
		reason:
			"needs wasm-ext legacy single-byte decoders (IBM866, ISO-8859-*, KOI8-*, macintosh, windows-*, x-mac-cyrillic)",
	},
	"encoding/unsupported-encodings.any.js": {
		expected: "skip",
		reason: "needs XMLHttpRequest polyfill (decoding-helpers.js uses XHR)",
	},
	"url/historical.any.js": { expected: "pass" },
	"url/url-searchparams.any.js": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/url-setters-stripping.any.js": { expected: "pass" },
	"url/url-statics-canparse.any.js": { expected: "pass" },
	"url/url-statics-parse.any.js": {
		expected: "skip",
		reason: "needs URL.parse static method in quickjs-wasi URL extension",
	},
	"url/url-tojson.any.js": { expected: "pass" },
	"url/urlsearchparams-append.any.js": { expected: "pass" },
	"url/urlsearchparams-constructor.any.js": { expected: "pass" },
	"url/urlsearchparams-delete.any.js": { expected: "pass" },
	"url/urlsearchparams-foreach.any.js": { expected: "pass" },
	"url/urlsearchparams-get.any.js": { expected: "pass" },
	"url/urlsearchparams-getall.any.js": { expected: "pass" },
	"url/urlsearchparams-has.any.js": { expected: "pass" },
	"url/urlsearchparams-set.any.js": { expected: "pass" },
	"url/urlsearchparams-size.any.js": { expected: "pass" },
	"url/urlsearchparams-sort.any.js": { expected: "pass" },
	"url/urlsearchparams-stringifier.any.js": { expected: "pass" },
	"url/**": {
		expected: "skip",
		reason:
			"fetch-for-vectors + Request/Response + IDL harness not yet shipped",
	},
	"WebCryptoAPI/**": {
		expected: "skip",
		reason:
			"first-run triage pending — mostly needs DOMException polyfill (for promise_rejects_dom / assert_throws_quotaexceedederror) + JWK export + external vectors",
	},
	"WebCryptoAPI/randomUUID.https.any.js": { expected: "pass" },
	"WebCryptoAPI/historical.any.js": {
		expected: "skip",
		reason:
			"sandbox does not model secure-context — crypto.subtle/SubtleCrypto/CryptoKey always present",
	},
	"WebCryptoAPI/supports.tentative.https.any.js": {
		expected: "skip",
		reason:
			"needs SubtleCrypto.supports() shim (not in globals.ts CRYPTO_PROMISE_SHIM method list)",
	},

	// --- Missing-polyfill skips (directory-wide) ---
	"html/webappapis/microtask-queuing/**": {
		expected: "skip",
		reason: "needs queueMicrotask polyfill",
	},
	"dom/abort/**": {
		expected: "skip",
		reason: "needs AbortController/AbortSignal polyfill",
	},
	"dom/events/**": {
		expected: "skip",
		reason: "needs EventTarget/Event polyfill",
	},
	"fetch/api/**": {
		expected: "skip",
		reason: "needs Request/Response/Headers class polyfills",
	},
	"streams/**": {
		expected: "skip",
		reason: "needs web-streams-polyfill",
	},
	"FileAPI/**": {
		expected: "skip",
		reason: "needs Blob/File polyfill",
	},
	"xhr/formdata/**": {
		expected: "skip",
		reason: "needs FormData polyfill",
	},
	"compression/**": {
		expected: "skip",
		reason: "needs CompressionStream polyfill",
	},
	"encoding/streams/**": {
		expected: "skip",
		reason: "needs TextEncoderStream polyfill",
	},
	"webidl/ecmascript-binding/DOMException-*": {
		expected: "skip",
		reason: "needs DOMException polyfill",
	},
	"url/urlpattern.any.js": {
		expected: "skip",
		reason: "needs urlpattern-polyfill",
	},
	"FileAPI/FileReader/**": {
		expected: "skip",
		reason: "needs FileReader polyfill",
	},

	// --- Structural skips (no polyfill helps) ---
	"**/idlharness-*.any.js": {
		expected: "skip",
		reason: "requires browser-style IDL introspection",
	},
	"fetch/api/cors/**": {
		expected: "skip",
		reason: "no browser origin model in sandbox",
	},
	"fetch/api/credentials/**": {
		expected: "skip",
		reason: "no browser credential model",
	},
	"fetch/api/integrity/**": {
		expected: "skip",
		reason: "requires subresource integrity semantics",
	},
	"fetch/api/policies/**": {
		expected: "skip",
		reason: "no browser policy model",
	},
	"xhr/formdata/constructor-formdata-element.any.js": {
		expected: "skip",
		reason: "requires HTMLFormElement",
	},

	// --- Subtest-level overrides ---
	"WebCryptoAPI/import_export/test_jwk.https.any.js:JWK export RSA-OAEP": {
		expected: "skip",
		reason: "needs wasm-ext JWK export",
	},

	// `common/sab.js`'s createBuffer() probes `WebAssembly.Memory({shared:true})`
	// to obtain the SharedArrayBuffer constructor; the sandbox doesn't expose
	// `WebAssembly`, so every SharedArrayBuffer-parameterized subtest below
	// fails during setup. The matching ArrayBuffer variants do pass.
	"encoding/textdecoder-copy.any.js:Modify buffer after passing it in (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-8, 1 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-8, 2 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-8, 3 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-8, 4 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-8, 5 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16le, 1 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16le, 2 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16le, 3 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16le, 4 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16le, 5 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16be, 1 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16be, 2 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16be, 3 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16be, 4 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: utf-16be, 5 byte window (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/textdecoder-streaming.any.js:Streaming decode: UTF-8 chunk tests (SharedArrayBuffer)":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },

	// encodeInto SharedArrayBuffer data-matrix (7 inputs × 6 destination configs).
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with Hi and destination length 0, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with Hi and destination length 0, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with Hi and destination length 0, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with Hi and destination length 0, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with Hi and destination length 0, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with Hi and destination length 0, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A and destination length 10, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A and destination length 10, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A and destination length 10, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A and destination length 10, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A and destination length 10, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A and destination length 10, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆 and destination length 4, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆 and destination length 4, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆 and destination length 4, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆 and destination length 4, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆 and destination length 4, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆 and destination length 4, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆A and destination length 3, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆A and destination length 3, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆A and destination length 3, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆A and destination length 3, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆A and destination length 3, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with 𝌆A and destination length 3, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with \uFFFD\uFFFD\uFFFDA\uFFFD\uFFFD\uFFFDA¥Hi and destination length 10, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with \uFFFD\uFFFD\uFFFDA\uFFFD\uFFFD\uFFFDA¥Hi and destination length 10, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with \uFFFD\uFFFD\uFFFDA\uFFFD\uFFFD\uFFFDA¥Hi and destination length 10, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with \uFFFD\uFFFD\uFFFDA\uFFFD\uFFFD\uFFFDA¥Hi and destination length 10, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with \uFFFD\uFFFD\uFFFDA\uFFFD\uFFFD\uFFFDA¥Hi and destination length 10, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with \uFFFD\uFFFD\uFFFDA\uFFFD\uFFFD\uFFFDA¥Hi and destination length 10, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A\uFFFD\uFFFD\uFFFD and destination length 4, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A\uFFFD\uFFFD\uFFFD and destination length 4, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A\uFFFD\uFFFD\uFFFD and destination length 4, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A\uFFFD\uFFFD\uFFFD and destination length 4, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A\uFFFD\uFFFD\uFFFD and destination length 4, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with A\uFFFD\uFFFD\uFFFD and destination length 4, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with ¥¥ and destination length 4, offset 0, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with ¥¥ and destination length 4, offset 4, filler 0":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with ¥¥ and destination length 4, offset 0, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with ¥¥ and destination length 4, offset 4, filler 128":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with ¥¥ and destination length 4, offset 0, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:encodeInto() into SharedArrayBuffer with ¥¥ and destination length 4, offset 4, filler random":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },

	// encodeInto invalid-destination SharedArrayBuffer variants.
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: DataView, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Int8Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Int16Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Int32Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Uint16Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Uint32Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Uint8ClampedArray, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: BigInt64Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: BigUint64Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Float16Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Float32Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: Float64Array, backed by: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },
	"encoding/encodeInto.any.js:Invalid encodeInto() destination: SharedArrayBuffer":
		{ expected: "skip", reason: "needs WebAssembly shim for common/sab.js" },

	"encoding/encodeInto.any.js:encodeInto() and a detached output buffer": {
		expected: "skip",
		reason: "needs MessageChannel polyfill (test detaches via postMessage)",
	},

	// QuickJS TextDecoder throws TypeError on a detached ArrayBuffer argument;
	// the spec expects it to coerce to an empty view and return "".
	"encoding/textdecoder-arguments.any.js:TextDecoder decode() with array buffer detached during arg conversion":
		{
			expected: "skip",
			reason:
				"wasm-ext TextDecoder throws on detached ArrayBuffer instead of returning empty string",
		},

	// First-run narrow skips for individual files whose setup or timing
	// doesn't match our sandbox (setup throws on missing globals, watchdog
	// trips on long-deadline spec examples, setInterval-with-no-interval
	// follows a different spec path than the host setInterval).
	"html/webappapis/atob/base64.any.js:atob() setup.": {
		expected: "skip",
		reason:
			"testharness setup() call triggered; revisit when EventTarget ships",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Blob basic": {
		expected: "skip",
		reason: "needs Blob polyfill",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Blob unpaired high surrogate (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Blob unpaired low surrogate (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Blob paired surrogates (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Blob empty": {
		expected: "skip",
		reason: "needs Blob polyfill",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Blob NUL": {
		expected: "skip",
		reason: "needs Blob polyfill",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, Blob basic":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, Blob unpaired high surrogate (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, Blob unpaired low surrogate (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, Blob paired surrogates (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, Blob empty":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, Blob NUL":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Blob object, two Blobs":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Blob object, Blob basic":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Blob object, Blob unpaired high surrogate (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Blob object, Blob unpaired low surrogate (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Blob object, Blob paired surrogates (invalid utf-8)":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Blob object, Blob empty":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Blob object, Blob NUL":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:File basic": {
		expected: "skip",
		reason: "needs File polyfill",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Transferring a non-transferable platform object fails":
		{
			expected: "skip",
			reason: "needs transferable Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:MessagePort": {
		expected: "skip",
		reason: "needs MessagePort polyfill",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:A detached platform object cannot be transferred":
		{
			expected: "skip",
			reason: "needs MessagePort polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:An object whose interface is deleted from the global object must still be received":
		{
			expected: "skip",
			reason: "needs MessagePort polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:A subclass instance will be received as its closest transferable superclass":
		{
			expected: "skip",
			reason: "needs ReadableStream polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Serializing a non-serializable platform object fails":
		{
			expected: "skip",
			reason: "needs Response polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:A subclass instance will deserialize as its closest serializable superclass":
		{
			expected: "skip",
			reason: "needs File polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:An object whose interface is deleted from the global must still deserialize":
		{
			expected: "skip",
			reason: "needs Blob polyfill",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Boolean true": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Boolean false": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Boolean objects":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Boolean objects":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:String empty string":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:String lone high surrogate":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:String lone low surrogate":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:String NUL": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:String astral character":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array String objects":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object String objects":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Number 0.2": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Number 0": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Number -0": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Number NaN": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Number Infinity": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Number -Infinity": {
		expected: "skip",
		reason: "structuredClone engine: wrapped primitive unwrapped",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Number 9007199254740992":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Number -9007199254740992":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Number 9007199254740994":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Number -9007199254740994":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array Number objects":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Object Number objects":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:BigInt -9007199254740994n":
		{
			expected: "skip",
			reason: "structuredClone engine: wrapped primitive unwrapped",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Array sparse": {
		expected: "skip",
		reason: "structuredClone engine: sparse array loses holes",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:Array with non-index property":
		{
			expected: "skip",
			reason: "structuredClone engine: drops non-index own properties",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Empty Error object":
		{
			expected: "skip",
			reason: "structuredClone engine: Error wrapper not preserved",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:ArrayBuffer": {
		expected: "skip",
		reason: "structuredClone engine: transfer-list not supported",
	},
	"html/webappapis/structured-clone/structured-clone.any.js:A detached ArrayBuffer cannot be transferred":
		{
			expected: "skip",
			reason: "structuredClone engine: transfer-list not supported",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Resizable ArrayBuffer is transferable":
		{
			expected: "skip",
			reason: "structuredClone engine: transfer-list not supported",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Length-tracking TypedArray is transferable":
		{
			expected: "skip",
			reason: "structuredClone engine: transfer-list not supported",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Length-tracking DataView is transferable":
		{
			expected: "skip",
			reason: "structuredClone engine: transfer-list not supported",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Resizable ArrayBuffer":
		{
			expected: "skip",
			reason: "structuredClone engine: resizable AB maxByteLength lost",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Growable SharedArrayBuffer":
		{
			expected: "skip",
			reason:
				"structuredClone engine: SharedArrayBuffer.prototype.grow missing",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Serializing OOB TypedArray throws":
		{
			expected: "skip",
			reason: "structuredClone engine: DataCloneError not a DOMException",
		},
	"html/webappapis/structured-clone/structured-clone.any.js:Serializing OOB DataView throws":
		{
			expected: "skip",
			reason: "structuredClone engine: DataCloneError not a DOMException",
		},
	"html/webappapis/timers/evil-spec-example.any.js": {
		expected: "skip",
		reason: "watchdog trips; requires nested-event-loop semantics",
	},
	"html/webappapis/timers/missing-timeout-setinterval.any.js:Calling setInterval with no interval should be the same as if called with 0 interval":
		{
			expected: "skip",
			reason:
				"host setInterval(fn) without delay treats undefined differently than spec",
		},
	"url/urlsearchparams-constructor.any.js:URLSearchParams constructor, DOMException as argument":
		{
			expected: "skip",
			reason: "needs DOMException polyfill",
		},
	"url/urlsearchparams-constructor.any.js:URLSearchParams constructor, FormData.":
		{
			expected: "skip",
			reason: "needs FormData polyfill",
		},
	"url/urlsearchparams-constructor.any.js:Basic URLSearchParams construction": {
		expected: "skip",
		reason: "needs URLSearchParams iterable ctor in quickjs-wasi",
	},
	"url/urlsearchparams-constructor.any.js:URLSearchParams constructor, object.":
		{
			expected: "skip",
			reason: "needs URLSearchParams iterable ctor in quickjs-wasi",
		},
	"url/urlsearchparams-constructor.any.js:Constructor with sequence of sequences of strings":
		{
			expected: "skip",
			reason: "needs URLSearchParams iterable ctor in quickjs-wasi",
		},
	"url/urlsearchparams-constructor.any.js:Custom [Symbol.iterator]": {
		expected: "skip",
		reason: "needs URLSearchParams iterable ctor in quickjs-wasi",
	},
	"url/historical.any.js:URL: no structured serialize/deserialize support": {
		expected: "skip",
		reason: "quickjs-wasi structuredClone lacks URL DataCloneError branding",
	},
	"url/historical.any.js:URLSearchParams: no structured serialize/deserialize support":
		{
			expected: "skip",
			reason:
				"quickjs-wasi structuredClone lacks URLSearchParams DataCloneError branding",
		},
	"url/urlsearchparams-delete.any.js:Deleting all params removes ? from URL": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-delete.any.js:Removing non-existent param removes ? from URL":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-delete.any.js:Changing the query of a URL with an opaque path with trailing spaces":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-delete.any.js:Changing the query of a URL with an opaque path with trailing spaces and a fragment":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-foreach.any.js:For-of Check": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-foreach.any.js:empty": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-foreach.any.js:delete next param during iteration": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-foreach.any.js:delete current param during iteration": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-foreach.any.js:delete every param seen during iteration":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-size.any.js:URLSearchParams's size when obtained from a URL":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-size.any.js:URLSearchParams's size when obtained from a URL and using .search":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-sort.any.js:URL parse and sort: z=b&a=b&z=a&a=a": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-sort.any.js:URL parse and sort: \uFFFD=x&\uFFFC&\uFFFD=a":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-sort.any.js:URL parse and sort: \uFB03&\u{1F308}": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-sort.any.js:URL parse and sort: \u00E9&e\uFFFD&e\u0301":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-sort.any.js:URL parse and sort: z=z&a=a&z=y&a=b&z=x&a=c&z=w&a=d&z=v&a=e&z=u&a=f&z=t&a=g":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-sort.any.js:URL parse and sort: bbb&bb&aaa&aa=x&aa=y": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-sort.any.js:URL parse and sort: z=z&=f&=t&=x": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-sort.any.js:URL parse and sort: a\u{1F308}&a\u{1F4A9}": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-sort.any.js:Sorting non-existent params removes ? from URL":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
	"url/urlsearchparams-stringifier.any.js:URLSearchParams connected to URL": {
		expected: "skip",
		reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
	},
	"url/urlsearchparams-stringifier.any.js:URLSearchParams must not do newline normalization":
		{
			expected: "skip",
			reason: "needs URL.searchParams getter in quickjs-wasi URL extension",
		},
};

export { spec };
