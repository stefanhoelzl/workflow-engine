import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWorkflowManifest } from "../../test-utils/manifest.js";
import type {
	WorkflowEntry,
	WorkflowRegistry,
} from "../../workflow-registry.js";
import { queueMiddleware } from "./middleware.js";

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

function mount(
	registry: WorkflowRegistry,
	queuesRoot: string,
	sessionMw: MiddlewareHandler,
) {
	const m = queueMiddleware({ registry, sessionMw, queuesRoot });
	const app = new Hono();
	app.all(m.match, m.handler);
	if (m.match.endsWith("/*")) {
		app.all(m.match.slice(0, -2), m.handler);
	}
	return app;
}

let queuesRoot: string;
// biome-ignore lint/complexity/useMaxParams: queue file path is the (owner, repo, workflow, queue) tuple plus the file content — flattening into an options object hurts test readability for a 5-arg helper used a handful of times in this file
async function seedQueueFile(
	owner: string,
	repo: string,
	workflow: string,
	queue: string,
	content: string,
): Promise<void> {
	const dir = join(queuesRoot, owner, repo, workflow);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${queue}.ndjson`), content);
}

beforeEach(async () => {
	queuesRoot = await mkdtemp(join(tmpdir(), "queue-mw-"));
});
afterEach(async () => {
	await rm(queuesRoot, { recursive: true, force: true });
});

describe("queue middleware — scope pages", () => {
	it("renders empty state when no workflows declare queues", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w0", queues: [] },
		]);
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("No queues declared");
	});

	it("lists declared queues with their counts at workflow scope", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: ["jobs"] },
		]);
		await seedQueueFile("t0", "r0", "build", "jobs", '{"a":1}\n{"b":2}\n');
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/build");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(">jobs<");
		expect(html).toContain(">2<"); // count
	});

	it("uses adaptive titles at root scope", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: ["jobs"] },
		]);
		await seedQueueFile("t0", "r0", "build", "jobs", "");
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(">t0/r0/build/jobs<");
	});

	it("404s for non-member at every scope", async () => {
		const registry = makeRegistry([
			{ owner: "victim", repo: "r0", workflow: "w0", queues: ["q"] },
		]);
		const app = mount(registry, queuesRoot, memberSessionMw([]));
		for (const path of [
			"/queue/victim",
			"/queue/victim/r0",
			"/queue/victim/r0/w0",
			"/queue/victim/r0/w0/q/items",
		]) {
			// biome-ignore lint/performance/noAwaitInLoops: requests intentionally serial — each must complete before the next so a stray side-effect on one path can't pollute the next
			const res = await app.request(path);
			expect(res.status).toBe(404);
		}
	});

	it("404s when workflow has no declared queues at workflow scope", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: [] },
		]);
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		// /queue/t0/r0/build still resolves (workflow exists) but renders empty
		const res = await app.request("/queue/t0/r0/build");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("No queues declared");
	});

	it("does not leak across (owner, repo)", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "build", queues: ["a"] },
			{ owner: "victim", repo: "r0", workflow: "build", queues: ["b"] },
		]);
		await seedQueueFile("t0", "r0", "build", "a", '{"x":1}\n');
		await seedQueueFile("victim", "r0", "build", "b", '{"y":1}\n');
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
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
		await seedQueueFile("t0", "r0", "w", "q", '{"a":1}\n{"b":2}\n');
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/q/items");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toMatch(/<html\b/i);
		expect(html).not.toMatch(/<body\b/i);
		expect(html).toContain('class="queue-item"');
	});

	it("paginates with offset, including a load-more when more remain", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		const lines = Array.from(
			{ length: 60 },
			(_, i) => `${JSON.stringify({ i })}\n`,
		).join("");
		await seedQueueFile("t0", "r0", "w", "q", lines);
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const r1 = await app.request("/queue/t0/r0/w/q/items");
		const h1 = await r1.text();
		// Default limit 50, so 50 items + load-more for offset=50 (10 left)
		expect((h1.match(/class="queue-item"/g) ?? []).length).toBe(50);
		expect(h1).toContain("queue-load-more");
		expect(h1).toContain("offset=50");

		const r2 = await app.request("/queue/t0/r0/w/q/items?offset=50");
		const h2 = await r2.text();
		expect((h2.match(/class="queue-item"/g) ?? []).length).toBe(10);
		expect(h2).not.toContain("queue-load-more");
	});

	it("404s when queue is not declared even if file path were guessable", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["declared"] },
		]);
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/undeclared/items");
		expect(res.status).toBe(404);
	});

	it("returns an empty fragment with no load-more when the queue is empty", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/q/items");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain('class="queue-item"');
		expect(html).not.toContain("queue-load-more");
		expect(html).toContain("Queue is empty");
	});

	it("read does not consume the queue head", async () => {
		const registry = makeRegistry([
			{ owner: "t0", repo: "r0", workflow: "w", queues: ["q"] },
		]);
		const path = join(queuesRoot, "t0", "r0", "w", "q.ndjson");
		await mkdir(join(queuesRoot, "t0", "r0", "w"), { recursive: true });
		await writeFile(path, '{"a":1}\n{"b":2}\n');
		const app = mount(registry, queuesRoot, memberSessionMw(["t0"]));
		const res = await app.request("/queue/t0/r0/w/q/items");
		expect(res.status).toBe(200);
		// File state is unchanged after read.
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(path, "utf8");
		expect(content).toBe('{"a":1}\n{"b":2}\n');
	});
});
