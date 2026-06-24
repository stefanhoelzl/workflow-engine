import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createQueueStore,
	MAX_ITEM_BYTES,
	MAX_WORKFLOW_QUEUE_DEPTH,
	type ProducerMeta,
	type QueueScope,
	type QueueStore,
} from "./queue-store.js";
import { createTestLogger } from "./test-utils/logger.js";

const SCOPE: QueueScope = {
	owner: "acme",
	repo: "foo",
	workflow: "build",
	queue: "jobs",
};

function meta(over: Partial<ProducerMeta> = {}): ProducerMeta {
	return {
		enqueuedAt: new Date("2026-05-16T12:00:00Z"),
		invocationId: "inv-a3f2",
		triggerKind: "cron",
		triggerName: "everyFiveMinutes",
		...over,
	};
}

describe("QueueStore", () => {
	let dir: string;
	let instance: DuckDBInstance;
	let store: QueueStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "queue-store-test-"));
		instance = await DuckDBInstance.create(join(dir, "events.duckdb"));
		store = await createQueueStore({
			instance,
			logger: createTestLogger(),
		});
	});

	afterEach(async () => {
		await store.close();
		await instance.closeSync();
		await rm(dir, { recursive: true, force: true });
	});

	describe("put / get round-trip", () => {
		it("get returns the item value with producer metadata", async () => {
			await store.put(SCOPE, { url: "https://example.com" }, meta());
			const popped = await store.get(SCOPE);
			expect(popped).toBeDefined();
			expect(popped?.item).toEqual({ url: "https://example.com" });
			expect(popped?.invocationId).toBe("inv-a3f2");
			expect(popped?.triggerKind).toBe("cron");
			expect(popped?.triggerName).toBe("everyFiveMinutes");
			expect(popped?.enqueuedAt.toISOString()).toBe("2026-05-16T12:00:00.000Z");
		});

		it("get on empty queue returns undefined", async () => {
			const popped = await store.get(SCOPE);
			expect(popped).toBeUndefined();
		});

		it("preserves FIFO order", async () => {
			await store.put(SCOPE, { i: 1 }, meta());
			await store.put(SCOPE, { i: 2 }, meta());
			await store.put(SCOPE, { i: 3 }, meta());
			expect((await store.get(SCOPE))?.item).toEqual({ i: 1 });
			expect((await store.get(SCOPE))?.item).toEqual({ i: 2 });
			expect((await store.get(SCOPE))?.item).toEqual({ i: 3 });
			expect(await store.get(SCOPE)).toBeUndefined();
		});

		it("preserves FIFO independently across queues sharing IDENTITY", async () => {
			const a: QueueScope = { ...SCOPE, queue: "a" };
			const b: QueueScope = { ...SCOPE, queue: "b" };
			await store.put(a, { q: "a", i: 1 }, meta());
			await store.put(b, { q: "b", i: 1 }, meta());
			await store.put(a, { q: "a", i: 2 }, meta());
			await store.put(b, { q: "b", i: 2 }, meta());
			expect((await store.get(a))?.item).toEqual({ q: "a", i: 1 });
			expect((await store.get(b))?.item).toEqual({ q: "b", i: 1 });
			expect((await store.get(a))?.item).toEqual({ q: "a", i: 2 });
			expect((await store.get(b))?.item).toEqual({ q: "b", i: 2 });
		});

		it("preserves newlines and special characters in item bodies", async () => {
			const tricky = {
				multiline: "line1\nline2\nline3",
				quote: 'he said "hi"',
				unicode: "café — 🎉",
			};
			await store.put(SCOPE, tricky, meta());
			const popped = await store.get(SCOPE);
			expect(popped?.item).toEqual(tricky);
		});
	});

	describe("caps", () => {
		it("accepts an item exactly at the size cap", async () => {
			// Construct a JSON of exactly 1024 bytes:
			// `{"s":"<padding>"}` — overhead = 8 chars, padding length = 1016
			const padding = "x".repeat(MAX_ITEM_BYTES - 8);
			const item = { s: padding };
			expect(JSON.stringify(item).length).toBe(MAX_ITEM_BYTES);
			await expect(store.put(SCOPE, item, meta())).resolves.toBeUndefined();
		});

		it("rejects an item one byte over the cap", async () => {
			const padding = "x".repeat(MAX_ITEM_BYTES - 7);
			const item = { s: padding };
			expect(JSON.stringify(item).length).toBe(MAX_ITEM_BYTES + 1);
			await expect(store.put(SCOPE, item, meta())).rejects.toMatchObject({
				code: "queue.itemTooLarge",
			});
			expect(await store.count(SCOPE)).toBe(0);
		});

		it("rejects put when the workflow-wide depth cap is reached", async () => {
			for (let i = 0; i < MAX_WORKFLOW_QUEUE_DEPTH; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: filling to cap is inherently sequential — we need ordered FIFO state, not throughput
				await store.put(SCOPE, { i }, meta());
			}
			expect(await store.count(SCOPE)).toBe(MAX_WORKFLOW_QUEUE_DEPTH);
			await expect(store.put(SCOPE, { i: 1000 }, meta())).rejects.toMatchObject(
				{ code: "queue.full" },
			);
			expect(await store.count(SCOPE)).toBe(MAX_WORKFLOW_QUEUE_DEPTH);
		});

		it("the depth cap is shared across a workflow's queues, not per-queue", async () => {
			const a: QueueScope = { ...SCOPE, queue: "a" };
			const b: QueueScope = { ...SCOPE, queue: "b" };
			// Fill queue "a" to the cap; queue "b" (same workflow) then has
			// zero remaining budget.
			for (let i = 0; i < MAX_WORKFLOW_QUEUE_DEPTH; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: ordered fill to cap
				await store.put(a, { i }, meta());
			}
			await expect(store.put(b, { x: 1 }, meta())).rejects.toMatchObject({
				code: "queue.full",
			});
			// A different workflow has its own independent budget.
			const otherWorkflow: QueueScope = {
				owner: "acme",
				repo: "foo",
				workflow: "other",
				queue: "a",
			};
			await expect(
				store.put(otherWorkflow, { x: 1 }, meta()),
			).resolves.toBeUndefined();
		});
	});

	describe("count / list", () => {
		it("count returns 0 for empty queue", async () => {
			expect(await store.count(SCOPE)).toBe(0);
		});

		it("list returns items in FIFO order with metadata", async () => {
			await store.put(SCOPE, { i: 1 }, meta({ invocationId: "inv-1" }));
			await store.put(SCOPE, { i: 2 }, meta({ invocationId: "inv-2" }));
			await store.put(SCOPE, { i: 3 }, meta({ invocationId: "inv-3" }));
			const rows = await store.list(SCOPE, 0, 50);
			expect(rows.map((r) => r.item)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
			expect(rows.map((r) => r.invocationId)).toEqual([
				"inv-1",
				"inv-2",
				"inv-3",
			]);
			// seq is monotonic within a single queue, in put order
			expect(rows[0]!.seq < rows[1]!.seq).toBe(true);
			expect(rows[1]!.seq < rows[2]!.seq).toBe(true);
		});

		it("list paginates with offset+limit", async () => {
			for (let i = 0; i < 10; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: ordered seed inserts; FIFO order is what we're asserting
				await store.put(SCOPE, { i }, meta());
			}
			const page1 = await store.list(SCOPE, 0, 3);
			const page2 = await store.list(SCOPE, 3, 3);
			expect(page1.map((r) => r.item)).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
			expect(page2.map((r) => r.item)).toEqual([{ i: 3 }, { i: 4 }, { i: 5 }]);
		});
	});

	describe("removeDeclaration", () => {
		it("deletes all rows for a queue tuple", async () => {
			await store.put(SCOPE, { i: 1 }, meta());
			await store.put(SCOPE, { i: 2 }, meta());
			const removed = await store.removeDeclaration(SCOPE);
			expect(removed).toBe(2);
			expect(await store.count(SCOPE)).toBe(0);
		});

		it("deletes all queues under a workflow when queue is omitted", async () => {
			const q1: QueueScope = { ...SCOPE, queue: "jobs" };
			const q2: QueueScope = { ...SCOPE, queue: "emails" };
			const other: QueueScope = {
				owner: "acme",
				repo: "foo",
				workflow: "other-workflow",
				queue: "jobs",
			};
			await store.put(q1, { i: 1 }, meta());
			await store.put(q2, { i: 2 }, meta());
			await store.put(other, { i: 3 }, meta());
			const removed = await store.removeDeclaration({
				owner: "acme",
				repo: "foo",
				workflow: "build",
			});
			expect(removed).toBe(2);
			expect(await store.count(q1)).toBe(0);
			expect(await store.count(q2)).toBe(0);
			expect(await store.count(other)).toBe(1);
		});

		it("returns 0 when no rows match", async () => {
			expect(await store.removeDeclaration(SCOPE)).toBe(0);
		});
	});

	describe("reconcile", () => {
		it("removes orphan tuples not in the declared set", async () => {
			const declared: QueueScope = { ...SCOPE, queue: "jobs" };
			const orphan1: QueueScope = { ...SCOPE, queue: "removed-queue" };
			const orphan2: QueueScope = { ...SCOPE, queue: "another-removed" };
			await store.put(declared, { i: 1 }, meta());
			await store.put(orphan1, { i: 2 }, meta());
			await store.put(orphan2, { i: 3 }, meta());
			const removed = await store.reconcile([declared]);
			expect(removed).toBe(2);
			expect(await store.count(declared)).toBe(1);
			expect(await store.count(orphan1)).toBe(0);
			expect(await store.count(orphan2)).toBe(0);
		});

		it("leaves declared tuples untouched even when empty", async () => {
			const declared: QueueScope = { ...SCOPE, queue: "jobs" };
			// No rows for the declared tuple at all
			const removed = await store.reconcile([declared]);
			expect(removed).toBe(0);
		});

		it("removes everything when declared set is empty", async () => {
			await store.put(SCOPE, { i: 1 }, meta());
			await store.put({ ...SCOPE, queue: "other" }, { i: 2 }, meta());
			const removed = await store.reconcile([]);
			expect(removed).toBe(2);
		});

		it("tolerates an empty queue_items table", async () => {
			const removed = await store.reconcile([SCOPE]);
			expect(removed).toBe(0);
		});
	});

	describe("ping / close", () => {
		it("ping resolves on a healthy connection", async () => {
			await expect(store.ping()).resolves.toBeUndefined();
		});
	});

	describe("tenant isolation — cross-tenant fuzz", () => {
		// Spec scenario "Cross-tenant data is invisible across all accessor
		// methods" requires fuzzing across ≥20 distinct tuple pairs. We
		// programmatically generate them and run every accessor against each.
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cross-product fuzz is intentionally nested; the structure is the assertion
		it("data inserted as (A,B,W,Q) is invisible to every other scope", async () => {
			const owners = ["acme", "globex", "initech", "umbrella"];
			const repos = ["foo", "bar"];
			const workflows = ["build", "deploy"];
			const queues = ["jobs", "emails"];
			const scopes: QueueScope[] = [];
			for (const o of owners) {
				for (const r of repos) {
					for (const w of workflows) {
						for (const q of queues) {
							scopes.push({ owner: o, repo: r, workflow: w, queue: q });
						}
					}
				}
			}
			// 4 * 2 * 2 * 2 = 32 scopes (well over the ≥20 spec floor).
			expect(scopes.length).toBeGreaterThanOrEqual(20);

			// Insert one row per scope with a unique marker payload.
			for (let i = 0; i < scopes.length; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: seed inserts must complete before observation phase
				await store.put(scopes[i]!, { marker: i }, meta());
			}

			// For every (insertedScope, observerScope) pair where the two
			// differ, every accessor SHALL NOT surface insertedScope's data
			// to observerScope.
			for (let i = 0; i < scopes.length; i++) {
				for (let j = 0; j < scopes.length; j++) {
					if (i === j) {
						continue;
					}
					const obs = scopes[j]!;
					// biome-ignore lint/performance/noAwaitInLoops: each iteration's assertion depends on the previous state being unchanged
					expect(await store.count(obs)).toBe(1);
					// list — should contain only the observer's own row (marker=j)
					const rows = await store.list(obs, 0, 100);
					expect(rows.length).toBe(1);
					expect(rows[0]!.item).toEqual({ marker: j });
				}
			}

			// And get on each scope pops exactly its own row.
			for (let i = 0; i < scopes.length; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: ordered pops; per-scope assertion before next iteration
				const popped = await store.get(scopes[i]!);
				expect(popped?.item).toEqual({ marker: i });
				expect(await store.get(scopes[i]!)).toBeUndefined();
			}
		});

		it("removeDeclaration on one tuple does not touch siblings", async () => {
			const a: QueueScope = { ...SCOPE, queue: "a" };
			const b: QueueScope = { ...SCOPE, queue: "b" };
			const c: QueueScope = {
				owner: "other",
				repo: "r",
				workflow: "w",
				queue: "a",
			};
			await store.put(a, { x: "a" }, meta());
			await store.put(b, { x: "b" }, meta());
			await store.put(c, { x: "c" }, meta());
			await store.removeDeclaration(a);
			expect(await store.count(a)).toBe(0);
			expect(await store.count(b)).toBe(1);
			expect(await store.count(c)).toBe(1);
		});
	});

	describe("durability across instance reopen", () => {
		// Stand-in for the crash test: close cleanly, reopen, confirm rows
		// survive. Full SIGKILL fault injection would need a child process.
		it("rows persist across DuckDBInstance close + reopen", async () => {
			await store.put(SCOPE, { url: "survive-me" }, meta());
			await store.close();
			await instance.closeSync();
			// Reopen
			instance = await DuckDBInstance.create(join(dir, "events.duckdb"));
			store = await createQueueStore({
				instance,
				logger: createTestLogger(),
			});
			const popped = await store.get(SCOPE);
			expect(popped?.item).toEqual({ url: "survive-me" });
		});
	});
});
