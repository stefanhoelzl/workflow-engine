// reportError — evolved per WinterCG MCA. Dispatches a cancelable ErrorEvent
// on globalThis; forwards serialized payload to the web-platform plugin's
// `__reportErrorHost` descriptor only if the event was not default-prevented.
//
// Each property read on the reported value is try/guarded so a throwing
// getter cannot escape into guest code. See SECURITY.md §2.
//
// Capture-and-delete pattern: `__reportErrorHost` is captured into the
// module's closure at eval time (which becomes the IIFE closure in the
// bundled output); Phase-3 of the plugin-boot pipeline deletes the
// descriptor from globalThis because it's registered as `public: false`.
// Required by SECURITY.md §2 R-1 (private-by-default) + R-2 (locked
// internals).

const _report = (
	globalThis as { __reportErrorHost?: (payload: unknown) => void }
).__reportErrorHost;

interface Serialized {
	name: string;
	message: string;
	stack?: string;
	cause?: unknown;
}

function readField(value: unknown, key: string): string | undefined {
	try {
		const v = (value as Record<string, unknown>)[key];
		return typeof v === "string" ? v : undefined;
	} catch {
		return;
	}
}

function readCause(value: unknown): unknown {
	try {
		return (value as { cause?: unknown }).cause;
	} catch {
		return;
	}
}

function safeStringify(value: unknown): string {
	try {
		return String(value);
	} catch {
		return "[unserializable value]";
	}
}

function serialize(value: unknown, seen: Set<unknown>): Serialized {
	if (value == null) {
		return { name: "Error", message: String(value) };
	}
	if (typeof value !== "object") {
		return { name: "Error", message: String(value) };
	}
	if (seen.has(value)) {
		return { name: "Error", message: "[circular]" };
	}
	seen.add(value);
	const name = readField(value, "name");
	const message = readField(value, "message");
	const stack = readField(value, "stack");
	const out: Serialized = {
		name: name == null ? "Error" : name,
		message: message == null ? safeStringify(value) : message,
	};
	if (stack != null) {
		out.stack = stack;
	}
	const cause = readCause(value);
	if (cause !== undefined) {
		out.cause = serialize(cause, seen);
	}
	return out;
}

function extractMessage(err: unknown): string {
	const m = readField(err, "message");
	return m ?? safeStringify(err);
}

globalThis.reportError = (err: unknown): void => {
	// Construct a cancelable ErrorEvent and dispatch it locally. If a listener
	// calls preventDefault(), suppress the host forwarding.
	try {
		const ErrorEventCtor = (
			globalThis as unknown as {
				ErrorEvent: new (
					type: string,
					init: { error: unknown; message: string; cancelable: boolean },
				) => Event;
			}
		).ErrorEvent;
		const event = new ErrorEventCtor("error", {
			error: err,
			message: extractMessage(err),
			cancelable: true,
		});
		const notCancelled = globalThis.dispatchEvent(event);
		if (!notCancelled) {
			return;
		}
	} catch {
		// If ErrorEvent construction or dispatch throws, fall through to
		// host forwarding — never let reportError itself propagate.
	}
	try {
		if (_report) {
			_report(serialize(err, new Set()));
		}
	} catch {
		// Never propagate into guest.
	}
};

// Delete the raw bridge so guest code cannot read or overwrite it.
// Phase-3 of the plugin-boot pipeline deletes `__reportErrorHost`
// automatically because the descriptor is `public: false`. Nothing to do here.
