import { describe, expect, it } from "vitest";
import { limitedAll } from "./limited-all.js";

describe("limitedAll", () => {
	it("returns results in input order", async () => {
		const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
			await new Promise((r) => setTimeout(r, Math.random() * 10));
			return n * 10;
		});
		const result = await limitedAll(tasks, 3);
		expect(result).toEqual([10, 20, 30, 40, 50]);
	});

	it("caps concurrency", async () => {
		let live = 0;
		let peak = 0;
		const tasks = Array.from({ length: 20 }, () => async () => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((r) => setTimeout(r, 10));
			live--;
			return null;
		});
		await limitedAll(tasks, 4);
		expect(peak).toBeLessThanOrEqual(4);
	});

	it("handles empty input", async () => {
		const r = await limitedAll([], 4);
		expect(r).toEqual([]);
	});

	it("throws on concurrency < 1", async () => {
		await expect(limitedAll([async () => 1], 0)).rejects.toThrow(
			/concurrency must be >= 1/,
		);
	});

	it("handles concurrency > task count", async () => {
		const r = await limitedAll([async () => 1, async () => 2], 100);
		expect(r).toEqual([1, 2]);
	});
});
