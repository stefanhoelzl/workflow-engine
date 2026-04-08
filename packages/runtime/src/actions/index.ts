import type { ActionContext } from "../context/index.js";

interface Action {
	name: string;
	on: string;
	handler: (ctx: ActionContext) => Promise<void>;
}

export type { Action };
