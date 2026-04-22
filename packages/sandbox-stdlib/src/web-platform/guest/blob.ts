// Blob + File polyfill from fetch-blob (pure JS, no host bridge).
// State lives in module singleton; each QuickJS VM gets a fresh eval, so
// blob data never outlives one sandbox run.
//
// Must run AFTER streams.ts: fetch-blob's Blob.stream() reads
// globalThis.ReadableStream. fetch-blob's index.js has a top-level
// `if (!globalThis.ReadableStream)` fallback that dynamic-imports
// node:stream/web — that branch is dead code here because streams.ts
// already installs ReadableStream.

import { Blob } from "fetch-blob";
import { File } from "fetch-blob/file.js";

function install(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}

install("Blob", Blob);
install("File", File);
