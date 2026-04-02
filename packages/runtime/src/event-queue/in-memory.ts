import type { Event, EventQueue } from "./index.js";

class InMemoryEventQueue implements EventQueue {
	readonly events: Event[] = [];

	enqueue(event: Event): void {
		this.events.push(event);
	}
}

export { InMemoryEventQueue };
