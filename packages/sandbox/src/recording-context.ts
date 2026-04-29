import type { EmitOptions, PluginContext, RequestOptions } from "./plugin.js";

interface EmittedEvent {
	readonly kind: string;
	readonly options: EmitOptions;
}

interface FlatEvent {
	readonly kind: string;
	readonly name: string;
	readonly input?: unknown;
}

interface RecordedRequest {
	readonly prefix: string;
	readonly options: RequestOptions;
	result?: unknown;
	error?: unknown;
}

interface FlatRequest {
	readonly prefix: string;
	readonly name: string;
	readonly input?: unknown;
	result?: unknown;
	error?: unknown;
}

interface RecordingContext extends PluginContext {
	readonly events: EmittedEvent[];
	readonly flatEvents: FlatEvent[];
	readonly requests: RecordedRequest[];
	readonly flatRequests: FlatRequest[];
}

// Controls what `emit()` returns at runtime. Note the public
// `PluginContext.emit` signature already narrows the return type to `void`
// for non-open framings — these policies only affect what the runtime
// produces under the hood when a test forces inspection via the cast surface
// (e.g. asserting on minted ids in bridge.installDescriptor fixtures).
// - "open-only" (default): mint a fresh CallId only when `options.type === "open"`,
//   matching the bridge's real wire behaviour.
// - "always": mint a CallId for every emission. Useful when the test inspects
//   guest-function descriptors that emit leaf events but still expect distinct
//   CallId returns.
// - "never": always return 0.
type CallIdPolicy = "open-only" | "always" | "never";

interface RecordingContextOptions {
	readonly callIds?: CallIdPolicy;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups four parallel record buffers + emit/request implementations as a single cohesive unit; splitting requires threading state through extra closures
function recordingContext(opts?: RecordingContextOptions): RecordingContext {
	const events: EmittedEvent[] = [];
	const flatEvents: FlatEvent[] = [];
	const requests: RecordedRequest[] = [];
	const flatRequests: FlatRequest[] = [];
	const policy: CallIdPolicy = opts?.callIds ?? "open-only";
	let nextCallId = 0;

	function emit(kind: string, options: EmitOptions): never {
		events.push({ kind, options });
		flatEvents.push({
			kind,
			name: options.name,
			...(options.input === undefined ? {} : { input: options.input }),
		});
		// Same boundary cast as the real `createPluginContext` — the runtime
		// always produces a number, but the public type narrows to `void` for
		// non-open call sites.
		if (policy === "always") {
			return nextCallId++ as never;
		}
		if (policy === "open-only" && options.type === "open") {
			return nextCallId++ as never;
		}
		return 0 as never;
	}

	function request<T>(
		prefix: string,
		options: RequestOptions,
		fn: () => T | Promise<T>,
	): T | Promise<T> {
		const entry: RecordedRequest = { prefix, options };
		const flatEntry: FlatRequest = {
			prefix,
			name: options.name,
			...(options.input === undefined ? {} : { input: options.input }),
		};
		requests.push(entry);
		flatRequests.push(flatEntry);
		try {
			const r = fn();
			if (r instanceof Promise) {
				return r.then(
					(v) => {
						entry.result = v;
						flatEntry.result = v;
						return v;
					},
					(e) => {
						entry.error = e;
						flatEntry.error = e;
						throw e;
					},
				);
			}
			entry.result = r;
			flatEntry.result = r;
			return r;
		} catch (e) {
			entry.error = e;
			flatEntry.error = e;
			throw e;
		}
	}

	return { events, flatEvents, requests, flatRequests, emit, request };
}

export type {
	EmittedEvent,
	FlatEvent,
	FlatRequest,
	RecordedRequest,
	RecordingContext,
	RecordingContextOptions,
};
export { recordingContext };
