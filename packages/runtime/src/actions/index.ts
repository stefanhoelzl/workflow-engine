import type { Event } from "../event-queue/index.js";

interface Action {
	name: string;
	match: (event: Event) => boolean;
	handler: (event: Event) => void;
}

export type { Action };
