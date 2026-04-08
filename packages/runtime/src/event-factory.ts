import type { RuntimeEvent } from "./event-bus/index.js";
import { PayloadValidationError } from "./context/errors.js";

interface Schema {
	parse(data: unknown): unknown;
}

interface EventFactory {
	create(type: string, payload: unknown, correlationId: string): RuntimeEvent;
	derive(parent: RuntimeEvent, type: string, payload: unknown): RuntimeEvent;
	fork(parent: RuntimeEvent, options: { targetAction: string }): RuntimeEvent;
}

function createEventFactory(
	schemas: Record<string, Schema>,
): EventFactory {
	function validate(type: string, payload: unknown): unknown {
		const schema = schemas[type];
		if (!schema) {
			throw new PayloadValidationError(type, []);
		}
		try {
			return schema.parse(payload);
		} catch (error) {
			const issues =
				error instanceof Error && "issues" in error && Array.isArray((error as { issues: unknown[] }).issues)
					? (error as { issues: { path: (string | number)[]; message: string }[] }).issues.map(
							(issue) => ({
								path: issue.path.join("."),
								message: issue.message,
							}),
						)
					: [];
			throw new PayloadValidationError(type, issues, error instanceof Error ? error : undefined);
		}
	}

	return {
		create(type, payload, correlationId) {
			const parsed = validate(type, payload);
			return {
				id: `evt_${crypto.randomUUID()}`,
				type,
				payload: parsed,
				correlationId,
				createdAt: new Date(),
				state: "pending",
			};
		},

		derive(parent, type, payload) {
			const parsed = validate(type, payload);
			return {
				id: `evt_${crypto.randomUUID()}`,
				type,
				payload: parsed,
				correlationId: parent.correlationId,
				parentEventId: parent.id,
				createdAt: new Date(),
				state: "pending",
			};
		},

		fork(parent, { targetAction }) {
			return {
				id: `evt_${crypto.randomUUID()}`,
				type: parent.type,
				payload: parent.payload,
				correlationId: parent.correlationId,
				parentEventId: parent.id,
				targetAction,
				createdAt: new Date(),
				state: "pending",
			};
		},
	};
}

export { createEventFactory };
export type { EventFactory };
