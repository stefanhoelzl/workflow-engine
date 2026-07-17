import type { PluginContext } from "@workflow-engine/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { QueueHostApi } from "./host-contract.js";
import { guest, QUEUE_DISPATCHER_NAME } from "./index.js";
import type { ActiveContext } from "./worker.js";
import { dispatchGet, dispatchPut, mapHostError } from "./worker.js";

// ---------------------------------------------------------------------------
// Worker-proxy tests. Post queues-on-duckdb the worker is config-less pure
// transport: it forwards put/get via `ctx.callHost` with the per-invocation
// context, and maps host-side QueueErrors back to the guest surface. ALL
// policy (declared-set membership, schema validation, caps, enqueuedAt) lives
// MAIN-side — see `queue-store.test.ts` and the e2e round-trip for that
// coverage. These tests exercise only the proxy contract.
// ---------------------------------------------------------------------------

const ACTIVE: ActiveContext = {
	repo: "foo",
	invocationId: "inv-a3f2",
	triggerKind: "cron",
	triggerName: "everyFiveMinutes",
};

function stubCtx(impl: {
	put?: (args: unknown) => Promise<unknown>;
	get?: (args: unknown) => Promise<unknown>;
}): PluginContext<QueueHostApi> {
	const callHost = vi.fn(async (method: string, args: unknown[]) => {
		if (method === "queue.put" && impl.put) {
			return impl.put(args[0]);
		}
		if (method === "queue.get" && impl.get) {
			return impl.get(args[0]);
		}
		throw new Error(`unexpected host-call method: ${method}`);
	});
	return { callHost } as unknown as PluginContext<QueueHostApi>;
}

describe("dispatchPut", () => {
	it("forwards {queue, item, repo, ...metadata} via callHost", async () => {
		let received: unknown;
		const ctx = stubCtx({
			put: async (args) => {
				received = args;
				return null;
			},
		});
		await dispatchPut(ctx, ACTIVE, "jobs", { url: "https://example.com" }, "");
		expect(received).toEqual({
			queue: "jobs",
			item: { url: "https://example.com" },
			key: "",
			repo: "foo",
			invocationId: "inv-a3f2",
			triggerKind: "cron",
			triggerName: "everyFiveMinutes",
		});
		// enqueuedAt is NOT forwarded — the host stamps it at INSERT time.
		expect(received).not.toHaveProperty("enqueuedAt");
	});

	it("returns null result wire", async () => {
		const ctx = stubCtx({ put: async () => null });
		const r = await dispatchPut(ctx, ACTIVE, "jobs", {}, "");
		expect(r).toBeNull();
	});

	it("re-wraps host QueueError into worker-side QueueError", async () => {
		const ctx = stubCtx({
			put: async () => {
				const e = new Error("item too big");
				e.name = "QueueError";
				(e as Error & { code: string }).code = "queue.itemTooLarge";
				throw e;
			},
		});
		await expect(
			dispatchPut(ctx, ACTIVE, "jobs", {}, ""),
		).rejects.toMatchObject({
			code: "queue.itemTooLarge",
			message: "item too big",
		});
	});

	it("translates host transport failure to queue.gone", async () => {
		const ctx = stubCtx({
			put: async () => {
				throw new Error("worker port closed");
			},
		});
		await expect(
			dispatchPut(ctx, ACTIVE, "jobs", {}, ""),
		).rejects.toMatchObject({
			code: "queue.gone",
		});
	});
});

describe("dispatchGet", () => {
	it("forwards {queue, repo} via callHost", async () => {
		let received: unknown;
		const ctx = stubCtx({
			get: async (args) => {
				received = args;
				return { found: false };
			},
		});
		await dispatchGet(ctx, ACTIVE, "jobs", "");
		expect(received).toEqual({ queue: "jobs", repo: "foo", key: "" });
	});

	it("returns {found: false} on empty queue", async () => {
		const ctx = stubCtx({ get: async () => ({ found: false }) });
		const r = await dispatchGet(ctx, ACTIVE, "jobs", "");
		expect(r).toEqual({ found: false });
	});

	it("returns {found: true, item} on popped row", async () => {
		const ctx = stubCtx({
			get: async () => ({ found: true, item: { url: "https://a" } }),
		});
		const r = await dispatchGet(ctx, ACTIVE, "jobs", "");
		expect(r).toEqual({ found: true, item: { url: "https://a" } });
	});

	it("re-wraps host schema-mismatch with item payload", async () => {
		const droppedItem = { malformed: "yes" };
		const ctx = stubCtx({
			get: async () => {
				const e = new Error("popped item failed schema");
				e.name = "QueueError";
				(e as Error & { code: string; item: unknown }).code =
					"queue.schemaMismatch";
				(e as Error & { code: string; item: unknown }).item = droppedItem;
				throw e;
			},
		});
		await expect(dispatchGet(ctx, ACTIVE, "jobs", "")).rejects.toMatchObject({
			code: "queue.schemaMismatch",
			item: droppedItem,
		});
	});
});

describe("guest shim __queue", () => {
	it("defaults an omitted key to '' and forwards explicit keys", async () => {
		const calls: unknown[] = [];
		const g = globalThis as Record<string, unknown>;
		g[QUEUE_DISPATCHER_NAME] = async (input: unknown) => {
			calls.push(input);
			return { found: false };
		};
		// guest() installs a locked `__queue` global exactly once.
		guest();
		const q = g.__queue as {
			put: (n: string, i: unknown, k?: string) => Promise<void>;
			get: (n: string, k?: string) => Promise<unknown>;
		};

		await q.put("jobs", { x: 1 });
		await q.get("jobs");
		await q.put("jobs", { x: 2 }, "alice");
		await q.get("jobs", "bob");

		expect(calls[0]).toEqual({
			op: "put",
			name: "jobs",
			item: { x: 1 },
			key: "",
		});
		expect(calls[1]).toEqual({ op: "get", name: "jobs", key: "" });
		expect(calls[2]).toEqual({
			op: "put",
			name: "jobs",
			item: { x: 2 },
			key: "alice",
		});
		expect(calls[3]).toEqual({ op: "get", name: "jobs", key: "bob" });
	});
});

describe("mapHostError", () => {
	it("maps QueueError-shaped Error to QueueError", () => {
		const src = new Error("nope");
		src.name = "QueueError";
		(src as Error & { code: string }).code = "queue.full";
		const out = mapHostError(src);
		expect(out.code).toBe("queue.full");
	});

	it("preserves item when present", () => {
		const src = new Error("schema");
		src.name = "QueueError";
		(src as Error & { code: string; item: unknown }).code =
			"queue.schemaMismatch";
		(src as Error & { code: string; item: unknown }).item = { x: 1 };
		const out = mapHostError(src);
		expect(out.item).toEqual({ x: 1 });
	});

	it("maps unknown errors to queue.gone", () => {
		const out = mapHostError(new Error("oh no"));
		expect(out.code).toBe("queue.gone");
		expect(out.message).toBe("oh no");
	});

	it("rejects unknown code strings (defense in depth)", () => {
		const src = new Error("forged");
		src.name = "QueueError";
		(src as Error & { code: string }).code = "queue.notReal";
		const out = mapHostError(src);
		expect(out.code).toBe("queue.gone");
	});
});
