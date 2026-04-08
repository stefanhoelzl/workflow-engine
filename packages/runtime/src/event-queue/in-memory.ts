import type { Event, EventQueue } from "./index.js";

type EventState = "pending" | "processing" | "done" | "failed";

interface StoredEvent {
	event: Event;
	state: EventState;
}

class InMemoryEventQueue implements EventQueue {
	readonly #entries: StoredEvent[] = [];
	readonly #waiters: Array<(event: Event) => void> = [];

	constructor(initialEvents: Event[] = []) {
		for (const event of initialEvents) {
			this.#entries.push({ event, state: "pending" });
		}
	}

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

	dequeue(signal?: AbortSignal): Promise<Event> {
		const entry = this.#entries.find((e) => e.state === "pending");
		if (entry) {
			entry.state = "processing";
			return Promise.resolve(entry.event);
		}

		return new Promise<Event>((resolve, reject) => {
			const waiter = (event: Event) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(event);
			};

			const onAbort = () => {
				const idx = this.#waiters.indexOf(waiter);
				if (idx !== -1) {
					this.#waiters.splice(idx, 1);
				}
				reject(signal?.reason);
			};

			this.#waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	ack(eventId: string): Promise<Event> {
		const entry = this.#entries.find(
			(e) => e.event.id === eventId && e.state === "processing",
		);
		if (!entry) {
			throw new Error(`No processing event found for id: ${eventId}`);
		}
		entry.state = "done";
		return Promise.resolve(entry.event);
	}

	fail(eventId: string): Promise<Event> {
		const entry = this.#entries.find(
			(e) => e.event.id === eventId && e.state === "processing",
		);
		if (!entry) {
			throw new Error(`No processing event found for id: ${eventId}`);
		}
		entry.state = "failed";
		return Promise.resolve(entry.event);
	}
}

export { InMemoryEventQueue };
