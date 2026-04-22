// FormData polyfill from formdata-polyfill (pure JS, no host bridge).
// Depends on Blob and File being on globalThis — must run after blob.ts.

import { FormData } from "formdata-polyfill/esm.min.js";

Object.defineProperty(globalThis, "FormData", {
	value: FormData,
	writable: true,
	configurable: true,
	enumerable: true,
});
