import { describe, expect, it } from "vitest";
import { createRunQueue } from "./run-queue.js";

describe("createRunQueue", () => {
	it("serializes runs — a second run does not start until the first settles", async () => {
		const q = createRunQueue();
		const order: string[] = [];
		let resolveA: (v: number) => void = () => undefined;

		const a = q.run(
			() =>
				new Promise<number>((resolve) => {
					order.push("a:start");
					resolveA = (v) => {
						order.push("a:end");
						resolve(v);
					};
				}),
		);

		const b = q.run(async () => {
			order.push("b:start");
			return "b";
		});

		// Wait one macrotask so if B were going to race it would have started.
		await new Promise((r) => setTimeout(r, 5));
		expect(order).toEqual(["a:start"]);

		resolveA(42);
		expect(await a).toBe(42);
		expect(await b).toBe("b");
		expect(order).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("a failure on one run unblocks the next", async () => {
		const q = createRunQueue();
		const err = new Error("fail-1");

		const a = q.run(async () => {
			throw err;
		});
		const b = q.run(async () => "b");

		await expect(a).rejects.toThrow("fail-1");
		await expect(b).resolves.toBe("b");
	});

	it("returns the value from the inner fn", async () => {
		const q = createRunQueue();
		const result = await q.run(async () => ({ a: 1 }));
		expect(result).toEqual({ a: 1 });
	});

	it("serializes a large number of runs in order", async () => {
		const q = createRunQueue();
		const order: number[] = [];
		const promises = Array.from({ length: 10 }).map((_, i) =>
			q.run(async () => {
				await new Promise((r) => setTimeout(r, 1));
				order.push(i);
				return i;
			}),
		);
		const results = await Promise.all(promises);
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("independent queues run in parallel", async () => {
		const q1 = createRunQueue();
		const q2 = createRunQueue();
		let q1Started = false;
		let q2Started = false;

		const p1 = q1.run(async () => {
			q1Started = true;
			await new Promise((r) => setTimeout(r, 20));
			return 1;
		});
		const p2 = q2.run(async () => {
			q2Started = true;
			await new Promise((r) => setTimeout(r, 20));
			return 2;
		});

		await new Promise((r) => setTimeout(r, 1));
		expect(q1Started).toBe(true);
		expect(q2Started).toBe(true);
		await Promise.all([p1, p2]);
	});
});
