import type { ActionContext } from "../context/index.js";
import type { Event } from "../event-queue/index.js";

interface Action {
	name: string;
	match: (event: Event) => boolean;
	handler: (ctx: ActionContext) => Promise<void>;
}

export type { Action };
