import type { LogEntry } from "@workflow-engine/sandbox";
import { PayloadValidationError } from "./context/errors.js";
import type { EventBus, RuntimeEvent } from "./event-bus/index.js";

interface Schema {
	parse(data: unknown): unknown;
}

type TransitionOpts =
	| { state: "processing" }
	| { state: "done"; result: "succeeded" | "skipped"; logs?: LogEntry[] }
	| {
			state: "done";
			result: "failed";
			error: { message: string; stack: string };
			logs?: LogEntry[];
	  };

interface EventSource {
	create(type: string, payload: unknown, source: string): Promise<RuntimeEvent>;
	derive(
		parent: RuntimeEvent,
		type: string,
		payload: unknown,
		source: string,
	): Promise<RuntimeEvent>;
	fork(
		parent: RuntimeEvent,
		options: { targetAction: string },
	): Promise<RuntimeEvent>;
	transition(event: RuntimeEvent, opts: TransitionOpts): Promise<void>;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled event creation + emission logic
function createEventSource(
	schemaSource: { readonly events: Record<string, Schema> },
	bus: EventBus,
): EventSource {
	function validate(type: string, payload: unknown): unknown {
		const schema = schemaSource.events[type];
		if (!schema) {
			throw new PayloadValidationError(type, []);
		}
		try {
			return schema.parse(payload);
		} catch (error) {
			const issues =
				error instanceof Error &&
				"issues" in error &&
				Array.isArray((error as { issues: unknown[] }).issues)
					? (
							error as {
								issues: { path: (string | number)[]; message: string }[];
							}
						).issues.map((issue) => ({
							path: issue.path.join("."),
							message: issue.message,
						}))
					: [];
			throw new PayloadValidationError(
				type,
				issues,
				error instanceof Error ? error : undefined,
			);
		}
	}

	return {
		async create(type, payload, source) {
			const parsed = validate(type, payload);
			const now = new Date();
			const event: RuntimeEvent = {
				id: `evt_${crypto.randomUUID()}`,
				type,
				payload: parsed,
				correlationId: `corr_${crypto.randomUUID()}`,
				createdAt: now,
				emittedAt: now,
				state: "pending",
				sourceType: "trigger",
				sourceName: source,
			};
			await bus.emit(event);
			return event;
		},

		async derive(parent, type, payload, source) {
			const parsed = validate(type, payload);
			const now = new Date();
			const event: RuntimeEvent = {
				id: `evt_${crypto.randomUUID()}`,
				type,
				payload: parsed,
				correlationId: parent.correlationId,
				parentEventId: parent.id,
				createdAt: now,
				emittedAt: now,
				state: "pending",
				sourceType: "action",
				sourceName: source,
			};
			await bus.emit(event);
			return event;
		},

		async fork(parent, { targetAction }) {
			const now = new Date();
			const event: RuntimeEvent = {
				id: `evt_${crypto.randomUUID()}`,
				type: parent.type,
				payload: parent.payload,
				correlationId: parent.correlationId,
				parentEventId: parent.id,
				targetAction,
				createdAt: now,
				emittedAt: now,
				state: "pending",
				sourceType: parent.sourceType,
				sourceName: parent.sourceName,
			};
			await bus.emit(event);
			return event;
		},

		async transition(event, opts) {
			const now = new Date();
			if (opts.state === "processing") {
				await bus.emit({
					...event,
					state: "processing",
					emittedAt: now,
					startedAt: now,
				});
			} else {
				const doneAt = now;
				const startedAt = event.startedAt ?? doneAt;
				await bus.emit({
					...event,
					...opts,
					emittedAt: now,
					startedAt,
					doneAt,
				});
			}
		},
	};
}

export type { EventSource, TransitionOpts };
export { createEventSource };
