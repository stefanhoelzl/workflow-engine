// Live two-way bound URL.prototype.searchParams patch.
//
// Background. The WASM-ext URL provided by quickjs-wasi exposes
// `searchParams` as a snapshot getter: each access returns a fresh
// `URLSearchParams` parsed from `this.search`. That diverges from the
// WHATWG URL spec on two points:
//
//   1. Identity: `url.searchParams === url.searchParams` MUST hold.
//   2. Live binding: mutating the returned `URLSearchParams`
//      (`.append/.delete/.set/.sort`) MUST reflect back into the parent
//      URL's `search`, and re-assigning `url.search = "..."` MUST be
//      observable on the next `searchParams` access.
//
// Strategy. Wrap the global `URL` constructor with a Proxy whose
// `construct` trap installs per-instance accessors for `searchParams`.
// The accessor lazily caches a `URLSearchParams` keyed off the parent URL
// in a module-private `WeakMap`, and patches `.append/.delete/.set/.sort`
// ON THE CACHED INSTANCE (per-instance, never on
// `URLSearchParams.prototype` — plain `new URLSearchParams(...)` users are
// unaffected) to write back into `parentURL.search`. Read-back of
// `url.search` after a mutation goes through whatever underlying setter
// the WASM-ext URL exposes; the read invalidates and rebuilds the cache
// because we cannot interpose on the WASM-ext data property without
// losing the URL's C-level state.
//
// SECURITY.md §2 — no host bridge, no Node surface, no new global. The
// patch operates entirely on the existing `URL` / `URLSearchParams`
// constructors that the WASM extension already publishes.

const cache = new WeakMap<URL, URLSearchParams>();
// Tracks the snapshot of `url.search` at the time a cached USP was built;
// if a subsequent read finds the URL's `search` has changed (e.g. caller
// did `url.search = "?p=q"`), the cache entry is invalidated.
const cachedSearch = new WeakMap<URL, string>();
const PATCHED = Symbol("urlsearchparams-bound");

type PatchedUSP = URLSearchParams & { [PATCHED]?: true };

function bindWriteBack(usp: URLSearchParams, parent: URL): void {
	const patched = usp as PatchedUSP;
	if (patched[PATCHED]) {
		return;
	}
	const append = usp.append.bind(usp);
	const del = usp.delete.bind(usp);
	const set = usp.set.bind(usp);
	const sort = usp.sort.bind(usp);

	function reflect(): void {
		const s = usp.toString();
		const newSearch = s === "" ? "" : `?${s}`;
		// Write through the underlying URL setter (data property assign or
		// accessor setter — whichever the WASM-ext exposes). Then re-record
		// the snapshot so the next searchParams read sees a hit.
		parent.search = newSearch;
		cachedSearch.set(parent, parent.search);
	}

	Object.defineProperties(usp, {
		append: {
			value(this: URLSearchParams, name: string, value: string) {
				append(name, value);
				reflect();
			},
			writable: true,
			configurable: true,
		},
		delete: {
			value(
				this: URLSearchParams,
				...args: [name: string] | [name: string, value: string]
			) {
				(del as (...a: unknown[]) => void)(...args);
				reflect();
			},
			writable: true,
			configurable: true,
		},
		set: {
			value(this: URLSearchParams, name: string, value: string) {
				set(name, value);
				reflect();
			},
			writable: true,
			configurable: true,
		},
		sort: {
			value(this: URLSearchParams) {
				sort();
				reflect();
			},
			writable: true,
			configurable: true,
		},
		[PATCHED]: { value: true },
	});
}

function getOrCreateSearchParams(url: URL): URLSearchParams {
	const currentSearch = url.search;
	const lastSearch = cachedSearch.get(url);
	const cached = cache.get(url);
	if (cached !== undefined && lastSearch === currentSearch) {
		return cached;
	}
	const usp = new URLSearchParams(currentSearch);
	bindWriteBack(usp, url);
	cache.set(url, usp);
	cachedSearch.set(url, currentSearch);
	return usp;
}

const OriginalURL = URL;

function installInstanceSearchParams(url: URL): void {
	Object.defineProperty(url, "searchParams", {
		configurable: true,
		enumerable: true,
		get(): URLSearchParams {
			return getOrCreateSearchParams(url);
		},
	});
}

const URLProxy = new Proxy(OriginalURL, {
	construct(target, args, newTarget): URL {
		const inst = Reflect.construct(target, args, newTarget) as URL;
		installInstanceSearchParams(inst);
		return inst;
	},
});

// Replace the global URL with our wrapper. Reflect.* default forwarding
// preserves `URL.prototype`, static methods, and the `instanceof` chain
// (the Proxy shares the same target, so `instanceof URL` and
// `instanceof OriginalURL` both still work).
Object.defineProperty(globalThis, "URL", {
	value: URLProxy,
	writable: true,
	configurable: true,
});

// Fallback: also install on `URL.prototype` if it carries a configurable
// `searchParams` accessor. Covers callers that obtain a URL via static
// helpers (e.g. `URL.parse`) that bypass our `construct` trap.
const protoDescriptor = Object.getOwnPropertyDescriptor(
	OriginalURL.prototype,
	"searchParams",
);
if (protoDescriptor?.configurable) {
	Object.defineProperty(OriginalURL.prototype, "searchParams", {
		configurable: true,
		enumerable: true,
		get(this: URL): URLSearchParams {
			if (!(this instanceof OriginalURL)) {
				throw new TypeError("Illegal invocation");
			}
			return getOrCreateSearchParams(this);
		},
	});
}
