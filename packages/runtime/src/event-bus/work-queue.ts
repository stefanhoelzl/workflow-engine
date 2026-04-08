import type { BusConsumer, RuntimeEvent } from "./index.js";

interface WorkQueue extends BusConsumer {
	dequeue(signal?: AbortSignal): Promise<RuntimeEvent>;
}

function createWorkQueue(): WorkQueue {
	const buffer: RuntimeEvent[] = [];
	const waiters: Array<(event: RuntimeEvent) => void> = [];

	return {
		handle(event: RuntimeEvent): Promise<void> {
			if (event.state !== "pending") {
				return Promise.resolve();
			}

			if (waiters.length > 0) {
				// biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
				const waiter = waiters.shift()!;
				waiter(event);
				return Promise.resolve();
			}

			buffer.push(event);
			return Promise.resolve();
		},

		bootstrap(
			events: RuntimeEvent[],
			options?: { pending?: boolean },
		): Promise<void> {
			if (options?.pending === false) {
				return Promise.resolve();
			}

			for (const event of events) {
				if (event.state === "pending" || event.state === "processing") {
					buffer.push(event);
				}
			}
			return Promise.resolve();
		},

		dequeue(signal?: AbortSignal): Promise<RuntimeEvent> {
			const event = buffer.shift();
			if (event) {
				return Promise.resolve(event);
			}

			return new Promise<RuntimeEvent>((resolve, reject) => {
				const waiter = (event: RuntimeEvent) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(event);
				};

				const onAbort = () => {
					const idx = waiters.indexOf(waiter);
					if (idx !== -1) {
						waiters.splice(idx, 1);
					}
					reject(signal?.reason);
				};

				waiters.push(waiter);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
}

export { createWorkQueue };
export type { WorkQueue };
