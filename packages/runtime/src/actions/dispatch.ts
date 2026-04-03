import type { Action } from "./index.js";

function createDispatchAction(actions: Action[]): Action {
	return {
		name: "dispatch",
		match: (event) => event.targetAction === undefined,
		handler: async (ctx) => {
			for (const action of actions) {
				if (action.name === "dispatch") {
					continue;
				}

				const synthetic = { ...ctx.event, targetAction: action.name };
				if (action.match(synthetic)) {
					// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design
					await ctx.emit(ctx.event.type, ctx.event.payload, {
						targetAction: action.name,
					});
				}
			}
		},
	};
}

export { createDispatchAction };
