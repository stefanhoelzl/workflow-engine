// Must evaluate BEFORE `./indexed-db.js`. fake-indexeddb declares 11
// DOMException subclasses (DataError, InvalidStateError, ...) in its
// errors.js. WPT asserts `e.constructor === self.DOMException` in
// assert_throws_dom; with subclasses in place, `e.constructor` is the
// subclass, not DOMException.
//
// Replace globalThis.DOMException with a function that returns a native
// DOMException instance, and point NativeDOMException.prototype.constructor
// at the replacement. Subclasses now extend the replacement; super() returns
// a native instance; prototype-chain lookup of `.constructor` lands on the
// replacement — which is what globalThis.DOMException now is. Name and code
// are preserved because the native constructor is what builds the instance.

const NativeDOMException = (
	globalThis as unknown as {
		DOMException: new (message?: string, name?: string) => Error;
	}
).DOMException;

function PatchedDOMException(
	this: unknown,
	message?: string,
	name?: string,
): Error {
	if (!new.target) {
		throw new TypeError(
			"Failed to construct 'DOMException': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
		);
	}
	return new NativeDOMException(message, name);
}
Object.defineProperty(PatchedDOMException, "prototype", {
	value: NativeDOMException.prototype,
	writable: false,
	configurable: false,
	enumerable: false,
});

// Copy every own property of NativeDOMException (INDEX_SIZE_ERR, etc.) onto
// PatchedDOMException as own properties, preserving descriptors. WPT asserts
// `assert_own_property(DOMException, name)` for each WebIDL constant.
for (const name of Object.getOwnPropertyNames(NativeDOMException)) {
	if (name === "prototype" || name === "name" || name === "length") {
		continue;
	}
	const desc = Object.getOwnPropertyDescriptor(NativeDOMException, name);
	if (desc) {
		Object.defineProperty(PatchedDOMException, name, desc);
	}
}

// Override the function's own .name so `DOMException.name === "DOMException"`
// (tests assert e.g. `err.constructor.name === "DOMException"`).
Object.defineProperty(PatchedDOMException, "name", {
	value: "DOMException",
	writable: false,
	configurable: true,
});

Object.defineProperty(NativeDOMException.prototype, "constructor", {
	value: PatchedDOMException,
	writable: true,
	configurable: true,
});

Object.defineProperty(globalThis, "DOMException", {
	value: PatchedDOMException,
	writable: true,
	configurable: true,
	enumerable: false,
});
