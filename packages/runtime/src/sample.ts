import type { Action } from "./actions/index.js";
import type { HttpTriggerDefinition } from "./triggers/index.js";

export const sampleTriggers: HttpTriggerDefinition[] = [
	{
		path: "order",
		method: "POST",
		event: "order.received",
		response: { status: 202, body: { accepted: true } },
	},
];

export const sampleActions: Action[] = [
	{
		name: "validateOrder",
		match: (e) =>
			e.type === "order.received" && e.targetAction === "validateOrder",
		handler: async (ctx) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(
				`[validateOrder] validating event ${ctx.event.id}`,
				ctx.event.payload,
			);
			await ctx.emit("order.validated", ctx.event.payload);
		},
	},
	{
		name: "fulfillOrder",
		match: (e) =>
			e.type === "order.validated" && e.targetAction === "fulfillOrder",
		// biome-ignore lint/suspicious/useAwait: handler interface requires async
		handler: async (ctx) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(
				`[fulfillOrder] fulfilling event ${ctx.event.id}`,
				ctx.event.payload,
			);
		},
	},
	{
		name: "notifyCustomer",
		match: (e) =>
			e.type === "order.validated" && e.targetAction === "notifyCustomer",
		// biome-ignore lint/suspicious/useAwait: handler interface requires async
		handler: async (ctx) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(
				`[notifyCustomer] notifying for event ${ctx.event.id}`,
				ctx.event.payload,
			);
		},
	},
];
