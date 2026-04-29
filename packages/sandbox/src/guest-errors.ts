// Error classes for guest-function descriptor validation and Callable
// lifecycle. Extracted from the former `guest-function-install.ts` so
// `bridge.ts` (which now owns the install/marshal pipeline)
// and tests can import them without a circular dependency.

/**
 * Base class for errors that may cross the host/sandbox boundary into the
 * guest VM with their `.name` and `.message` preserved. The closure rule in
 * `bridge.ts`'s `buildHandler` recognises this class (via instanceof) as the
 * allowlist for propagating error detail to guest code; everything else
 * collapses to a generic `BridgeError` (see `openspec/specs/sandbox/spec.md`
 * — "Host/sandbox boundary opacity for thrown errors"). Plugin-side
 * dispatchers subclass this (e.g. `FetchError`, `MailError`, `SqlError`) or
 * instantiate it directly to opt into propagation.
 */
class GuestSafeError extends Error {
	readonly name: string = "GuestSafeError";
}

class GuestArgTypeMismatchError extends GuestSafeError {
	// biome-ignore lint/security/noSecrets: Error subclass name literal, not a credential
	override readonly name = "GuestArgTypeMismatchError";
	readonly descriptorName: string;
	readonly argIndex: number;
	readonly expected: string;
	readonly received: string;
	constructor(
		descriptorName: string,
		argIndex: number,
		expected: string,
		received: string,
	) {
		super(
			`guest function "${descriptorName}" arg[${argIndex}]: expected ${expected}, got ${received}`,
		);
		this.descriptorName = descriptorName;
		this.argIndex = argIndex;
		this.expected = expected;
		this.received = received;
	}
}

class GuestValidationError extends GuestSafeError {
	override readonly name = "GuestValidationError";
	readonly descriptorName: string;
	constructor(descriptorName: string, message: string) {
		super(`guest function "${descriptorName}": ${message}`);
		this.descriptorName = descriptorName;
	}
}

/**
 * Carries an error originating inside another guest VM across the host/
 * sandbox boundary. Constructed by `callGuestFn` / `awaitGuestResult` when
 * rethrowing a `JSException` host-side. The `.name` and `.stack` are
 * overwritten by the call sites to preserve the original guest error's
 * identity (e.g. `TypeError`, `RangeError`, an author-defined class name)
 * and the guest-side stack frames. The closure rule in `bridge.ts`
 * pass-through-routes instances of this class: preserves `.name` /
 * `.message` unchanged and appends a single `at <bridge:<publicName>>`
 * frame to the existing guest stack.
 */
class GuestThrownError extends GuestSafeError {
	override name = "GuestThrownError";
}

/**
 * Catch-all error class produced by the closure rule in `bridge.ts`'s
 * `buildHandler` for host throws that are NOT `GuestSafeError` instances.
 * Carries no inner detail — guest-observed `.message` is exactly
 * `"<publicName> failed"` and `.stack` is a single synthetic
 * `at <bridge:<publicName>>` frame. NOT a subclass of `GuestSafeError`
 * (that allowlist exists only for opted-in detail).
 */
class BridgeError extends Error {
	override readonly name = "BridgeError";
}

class CallableDisposedError extends Error {
	readonly name = "CallableDisposedError";
	constructor() {
		super("Callable has been disposed and can no longer be invoked");
	}
}

export {
	BridgeError,
	CallableDisposedError,
	GuestArgTypeMismatchError,
	GuestSafeError,
	GuestThrownError,
	GuestValidationError,
};
