import type { Action } from "../actions/index.js";
import type { EventQueue } from "../event-queue/index.js";

class Scheduler {
	readonly #queue: EventQueue;
	readonly #actions: Action[];
	#running = false;
	#loopPromise: Promise<void> | null = null;

	constructor(queue: EventQueue, actions: Action[]) {
		this.#queue = queue;
		this.#actions = actions;
	}

	start(): void {
		if (this.#running) {
			return;
		}
		this.#running = true;
		this.#loopPromise = this.#loop();
	}

	stop(): void {
		this.#running = false;
	}

	get stopped(): Promise<void> {
		return this.#loopPromise ?? Promise.resolve();
	}

	async #loop(): Promise<void> {
		while (this.#running) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential event processing by design
			const event = await this.#queue.dequeue();
			if (!this.#running) {
				await this.#queue.ack(event.id);
				break;
			}

			const matches = this.#actions.filter((a) => a.match(event));

			if (matches.length > 1) {
				await this.#queue.fail(event.id);
			} else {
				const action = matches.find(() => true);
				if (action) {
					try {
						action.handler(event);
						await this.#queue.ack(event.id);
					} catch {
						await this.#queue.fail(event.id);
					}
				} else {
					await this.#queue.ack(event.id);
				}
			}
		}
	}
}

export { Scheduler };
