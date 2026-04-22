// structuredClone — overrides the native quickjs-wasi implementation, which
// drops wrapper objects (Boolean/String/Number), sparse-array length, and
// non-index array properties. Uses @ungap/structured-clone (pure JS, WhatWG
// algorithm) for the heavy lifting; we wrap it to throw DataCloneError
// DOMException (the spec-required exception type) instead of TypeError, and
// to reject the `transfer` option since QuickJS lacks ArrayBuffer detachment.
//
// Named imports bypass ungap's default export, which would otherwise
// short-circuit to the (broken) native structuredClone when present.

import { deserialize, serialize } from "@ungap/structured-clone";

interface CloneOptions {
	transfer?: ArrayBuffer[];
}

const DOMExceptionCtor = (
	globalThis as unknown as {
		DOMException: new (message: string, name: string) => Error;
	}
).DOMException;

const UNGAP_NON_CLONEABLE_RE = /^unable to serialize /;

function structuredCloneShim<T>(value: T, options?: CloneOptions): T {
	if (options?.transfer && options.transfer.length > 0) {
		throw new DOMExceptionCtor(
			"Transferable objects are not supported",
			"DataCloneError",
		);
	}
	try {
		return deserialize(serialize(value)) as T;
	} catch (e) {
		// Only ungap's own cloneability TypeError gets wrapped as
		// DataCloneError. Errors thrown from user code (e.g. accessor
		// getters during serialization) propagate unchanged — this is
		// what WPT's "Object with a getter that throws" subtest asserts.
		if (e instanceof TypeError && UNGAP_NON_CLONEABLE_RE.test(e.message)) {
			throw new DOMExceptionCtor(e.message, "DataCloneError");
		}
		throw e;
	}
}

Object.defineProperty(globalThis, "structuredClone", {
	value: structuredCloneShim,
	writable: true,
	configurable: true,
	enumerable: true,
});
