import type { ActionContext } from "../context/index.js";
import type { RuntimeEvent } from "../event-bus/index.js";

interface Action {
	name: string;
	match: (event: RuntimeEvent) => boolean;
	handler: (ctx: ActionContext) => Promise<void>;
}

export type { Action };
