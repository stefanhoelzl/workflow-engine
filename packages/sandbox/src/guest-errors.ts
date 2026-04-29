// Error classes for guest-function descriptor validation and Callable
// lifecycle. Extracted from the former `guest-function-install.ts` so
// `bridge.ts` (which now owns the install/marshal pipeline)
// and tests can import them without a circular dependency.

class GuestArgTypeMismatchError extends Error {
	// biome-ignore lint/security/noSecrets: Error subclass name literal, not a credential
	readonly name = "GuestArgTypeMismatchError";
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

class GuestValidationError extends Error {
	readonly name = "GuestValidationError";
	readonly descriptorName: string;
	constructor(descriptorName: string, message: string) {
		super(`guest function "${descriptorName}": ${message}`);
		this.descriptorName = descriptorName;
	}
}

class CallableDisposedError extends Error {
	readonly name = "CallableDisposedError";
	constructor() {
		super("Callable has been disposed and can no longer be invoked");
	}
}

export {
	CallableDisposedError,
	GuestArgTypeMismatchError,
	GuestValidationError,
};
