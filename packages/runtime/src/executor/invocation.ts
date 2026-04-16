import type { HttpTriggerResult } from "@workflow-engine/core";
import type {
	CompletedEvent,
	FailedEvent,
	SerializedErrorPayload,
	StartedEvent,
} from "../event-bus/index.js";

// Invocation = the in-memory handle for a single trigger run. It tracks the
// id / workflow / trigger / payload and builds the three bus events via
// `startedEvent`, `complete(result)`, `fail(err)`. The factory never calls
// the bus itself; the executor does that, so this module stays pure.

interface Invocation {
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly input: unknown;
	readonly startedAt: Date;
	readonly startedEvent: StartedEvent;
	complete(result: HttpTriggerResult, ts?: Date): CompletedEvent;
	fail(error: SerializedErrorPayload, ts?: Date): FailedEvent;
}

interface NewInvocationArgs {
	readonly workflow: string;
	readonly trigger: string;
	readonly payload: unknown;
	// Injection points — default to real clock/UUID in production.
	readonly id?: string;
	readonly now?: () => Date;
}

const EVT_ID_RE = /^evt_[A-Za-z0-9_-]{8,}$/;

function defaultNow(): Date {
	return new Date();
}

function defaultId(): string {
	return `evt_${crypto.randomUUID()}`;
}

function newInvocation(args: NewInvocationArgs): Invocation {
	const id = args.id ?? defaultId();
	const now = args.now ?? defaultNow;
	const startedAt = now();

	const startedEvent: StartedEvent = {
		kind: "started",
		id,
		workflow: args.workflow,
		trigger: args.trigger,
		ts: startedAt,
		input: args.payload,
	};

	return {
		id,
		workflow: args.workflow,
		trigger: args.trigger,
		input: args.payload,
		startedAt,
		startedEvent,
		complete(result, ts) {
			return {
				kind: "completed",
				id,
				workflow: args.workflow,
				trigger: args.trigger,
				ts: ts ?? now(),
				result,
			};
		},
		fail(error, ts) {
			return {
				kind: "failed",
				id,
				workflow: args.workflow,
				trigger: args.trigger,
				ts: ts ?? now(),
				error,
			};
		},
	};
}

export type { Invocation, NewInvocationArgs };
export { EVT_ID_RE, newInvocation };
