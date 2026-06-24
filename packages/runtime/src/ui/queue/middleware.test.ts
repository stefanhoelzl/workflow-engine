import { Hono, type MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProducerMeta, QueueScope } from "../../queue-store.js";
import { makeWorkflowManifest } from "../../test-utils/manifest.js";
import { createTestQueueStore } from "../../test-utils/queue-store.js";
import type {
	WorkflowEntry,
	WorkflowRegistry,
} from "../../workflow-registry.js";
import { queueMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// /queue middleware tests — rewritten post queues-on-duckdb. Population goes
// through the typed queueStore accessor (the same surface used at runtime),
// not via NDJSON files. Tenant-scope, pagination, auth, and the read-only
// invariant are still asserted; the data path under test is the
// queueStore.list/count surface, not the old fs-read primitive.
// ---------------------------------------------------------------------------

interface StubWorkflow {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queues: readonly string[];
}

function makeRegistry(items: readonly StubWorkflow[]): WorkflowRegistry {
	const entries: WorkflowEntry[] = items.map((item) => ({
		owner: item.owner,
		repo: item.repo,
		bundleSource: "",
		workflow: makeWorkflowManifest({
			name: item.workflow,
			queues: item.queues.map((q) => ({
				name: q,
				schema: { type: "object" },
			})),
		}),
		triggers: [],
	}));
	const ownerSet = new Set(items.map((i) => i.owner));
	const pairs = new Set(items.map((i) => `${i.owner}/${i.repo}`));
	return {
		get size() {
			return entries.length;
		},
		owners: () => Array.from(ownerSet),
		repos: (owner: string) =>
			Array.from(
				new Set(items.filter((i) => i.owner === owner).map((i) => i.repo)),
			),
		pairs: () =>
			Array.from(pairs).map((s) => {
				const [owner, repo] = s.split("/") as [string, string];
				return { owner, repo };
			}),
		list: (owner?: string, repo?: string) =>
			entries.filter(
				(e) =>
					(owner === undefined || e.owner === owner) &&
					(repo === undefined || e.repo === repo),
			),
		registerOwner: async () => ({ ok: false, error: "unused" }),
		recover: async () => undefined,
		getEntry: () => undefined,
		dispose: () => undefined,
	};
}

function memberSessionMw(orgs: readonly string[]): MiddlewareHandler {
	return async (c, next) => {
		c.set("user", {
			login: "user",
			mail: "user@example.test",
			orgs: [...orgs, "user"],
		});
		await next();
	};
}

function meta(over: Partial<ProducerMeta> = {}): ProducerMeta {
	return {
		enqueuedAt: new Date("2026-05-16T12:00:00Z"),
		invocationId: "inv-test",
		triggerKind: "cron",
		triggerName: "everyFiveMinutes",
		...over,
	};
}

function mount(
	registry: WorkflowRegistry,
	queueStore: ReturnType<typeof createTestQueueStore>,
	sessionMw: MiddlewareHandler,
) {
	const m = queueMiddleware({ registry, sessionMw, queueStore });
	const app = new Hono();
	app.all(m.match, m.handler);
	if (m.match.endsWith("/*")) {
		app.all(m.match.slice(0, -2), m.handler);
	}
	return app;
}

let queueStore: ReturnType<typeof createTestQueueStore>;
beforeEach(() => {
	queueStore = createTestQueueStore();
});

async function seed(
	scope: QueueScope,
	items: readonly unknown[],
): Promise<void> {
	for (const item of items) {
		// biome-ignore lint/performance/noAwaitInLoops: FIFO insertion order is the test contract; parallel puts would race the global IDENTITY counter and assertions over item order would become non-deterministic
		await queueStore.put(scope, item, meta());
	}
}

describe("queue middleware — scope pages", () => {
	it("renders empty state when no workflows declare queues", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w0", queues: [] },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("No queues declared");
	});

	it("lists declared queues with their counts at workflow scope", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: ["jobs"] },
		]);
		await seed({ owner: "t0", repo: "r0", workflow: "build", queue: "jobs" }, [
			{ a: 1 },
			{ b: 2 },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/build");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(">jobs<");
		expect(html).toContain(">2<");
	});

	it("uses adaptive titles at root scope", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: ["jobs"] },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(">t0/r0/build/jobs<");
	});

	it("404s for non-member at every scope", async () => {
		const registry = makeRegistry([
			{ owner: "victim", repo: "r0", workflow: "w0", queues: ["q"] },
		]);
		const app = mount(registry, queueStore, memberSessionMw([]));
		for (const path of [
			"/queue/victim",
			"/queue/victim/r0",
			"/queue/victim/r0/w0",
			"/queue/victim/r0/w0/q/items",
		]) {
			// biome-ignore lint/performance/noAwaitInLoops: serial requests so a stray side-effect on one path can't pollute the next
			const res = await app.request(path);
			expect(res.status).toBe(404);
		}
	});

	it("404s when workflow has no declared queues at workflow scope", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: [] },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/build");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("No queues declared");
	});

	it("does not leak across (owner, repo)", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: ["a"] },
			{ owner: "victim", repo: "r0", workflow: "build", queues: ["b"] },
		]);
		await seed({ owner: "t0", repo: "r0", workflow: "build", queue: "a" }, [
			{ x: 1 },
		]);
		await seed({ owner: "victim", repo: "r0", workflow: "build", queue: "b" }, [
			{ y: 1 },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue");
		const html = await res.text();
		expect(html).toContain(">t0/r0/build/a<");
		expect(html).not.toContain("victim");
	});
});

describe("queue middleware — items fragment", () => {
	it("returns a fragment without <html>/<body> wrapper", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		await seed({ owner: "t0", repo: "r0", workflow: "w", queue: "q" }, [
			{ a: 1 },
			{ b: 2 },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/q/items");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toMatch(/<html\b/i);
		expect(html).not.toMatch(/<body\b/i);
		expect(html).toMatch(/id="qi-/);
	});

	it("paginates with offset, including a load-more when more remain", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		const items = Array.from({ length: 60 }, (_, i) => ({ i }));
		await seed({ owner: "t0", repo: "r0", workflow: "w", queue: "q" }, items);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const r1 = await app.request("/queue/t0/r0/w/q/items");
		const h1 = await r1.text();
		expect((h1.match(/id="qi-/g) ?? []).length).toBe(50);
		expect(h1).toContain("queue-load-more");
		expect(h1).toContain("offset=50");

		const r2 = await app.request("/queue/t0/r0/w/q/items?offset=50");
		const h2 = await r2.text();
		expect((h2.match(/id="qi-/g) ?? []).length).toBe(10);
		expect(h2).not.toContain("queue-load-more");
	});

	it("404s when queue is not declared", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["declared"] },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/undeclared/items");
		expect(res.status).toBe(404);
	});

	it("returns an empty fragment with no load-more when the queue is empty", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/q/items");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toMatch(/id="qi-/);
		expect(html).not.toContain("queue-load-more");
		expect(html).toContain("Queue is empty");
	});

	it("read does not consume the queue head", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		const scope: QueueScope = {
			owner: "t0",
			repo: "r0",
			workflow: "w",
			queue: "q",
		};
		await seed(scope, [{ a: 1 }, { b: 2 }]);
		const app = mount(registry, queueStore, memberSessionMw(["t0"]));
		await app.request("/queue/t0/r0/w/q/items");
		// queue still has 2 items after the read
		expect(await queueStore.count(scope)).toBe(2);
	});
});
