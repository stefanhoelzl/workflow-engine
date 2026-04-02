import type { Event, EventQueue } from "./index.js";

type EventState = "pending" | "processing" | "done" | "failed";

interface StoredEvent {
	event: Event;
	state: EventState;
}

class InMemoryEventQueue implements EventQueue {
	readonly #entries: StoredEvent[] = [];
	readonly #waiters: Array<(event: Event) => void> = [];

	enqueue(event: Event): Promise<void> {
		this.#entries.push({ event, state: "pending" });

		if (this.#waiters.length > 0) {
			const waiter = this.#waiters.shift();
			const entry = this.#entries.find((e) => e.state === "pending");
			if (waiter && entry) {
				entry.state = "processing";
				waiter(entry.event);
			}
		}

		return Promise.resolve();
	}

	dequeue(): Promise<Event> {
		const entry = this.#entries.find((e) => e.state === "pending");
		if (entry) {
			entry.state = "processing";
			return Promise.resolve(entry.event);
		}

		return new Promise<Event>((resolve) => {
			this.#waiters.push(resolve);
		});
	}

	ack(eventId: string): Promise<void> {
		const entry = this.#entries.find(
			(e) => e.event.id === eventId && e.state === "processing",
		);
		if (entry) {
			entry.state = "done";
		}
		return Promise.resolve();
	}

	fail(eventId: string): Promise<void> {
		const entry = this.#entries.find(
			(e) => e.event.id === eventId && e.state === "processing",
		);
		if (entry) {
			entry.state = "failed";
		}
		return Promise.resolve();
	}
}

export { InMemoryEventQueue };
