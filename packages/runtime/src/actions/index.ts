import type { ActionContext } from "../context/index.js";

interface Action {
	name: string;
	on: string;
	env: Record<string, string>;
	handler: (ctx: ActionContext) => Promise<void>;
}

export type { Action };
