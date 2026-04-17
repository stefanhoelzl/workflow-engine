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
	"encoding/textdecoder-byte-order-marks.any.js": { expected: "pass" },
	"encoding/textdecoder-fatal.any.js": { expected: "pass" },
	"encoding/textdecoder-fatal-streaming.any.js": { expected: "pass" },
	"encoding/textdecoder-ignorebom.any.js": { expected: "pass" },
	"encoding/textdecoder-utf16-surrogates.any.js": { expected: "pass" },
	"encoding/textencoder-utf16-surrogates.any.js": { expected: "pass" },
	"encoding/**": {
		expected: "skip",
		reason: "first-run triage pending (legacy encodings + fetch-for-vectors)",
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
		reason: "first-run triage pending (needs fetch-for-vectors)",
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

	// First-run narrow skips for individual files whose setup or timing
	// doesn't match our sandbox (setup throws on missing globals, watchdog
	// trips on long-deadline spec examples, setInterval-with-no-interval
	// follows a different spec path than the host setInterval).
	"html/webappapis/atob/base64.any.js:atob() setup.": {
		expected: "skip",
		reason:
			"testharness setup() call triggered; revisit when EventTarget ships",
	},
	"html/webappapis/structured-clone/structured-clone.any.js": {
		expected: "skip",
		reason: "setup throws on missing globals (ImageBitmap, DOMRect etc.)",
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
