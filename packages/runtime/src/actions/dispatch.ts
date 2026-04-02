import type { EventQueue } from "../event-queue/index.js";
import type { Action } from "./index.js";

function createDispatchAction(actions: Action[], queue: EventQueue): Action {
	return {
		name: "dispatch",
		match: (event) => event.targetAction === undefined,
		handler: (event) => {
			for (const action of actions) {
				if (action.name === "dispatch") {
					continue;
				}

				const synthetic = { ...event, targetAction: action.name };
				if (action.match(synthetic)) {
					queue.enqueue({
						...event,
						id: `evt_${crypto.randomUUID()}`,
						targetAction: action.name,
					});
				}
			}
		},
	};
}

export { createDispatchAction };
