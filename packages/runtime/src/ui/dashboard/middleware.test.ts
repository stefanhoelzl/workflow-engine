import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "../../auth/user-context.js";
import {
	createEventStore,
	type EventStore,
} from "../../event-bus/event-store.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { dashboardMiddleware } from "./middleware.js";

const emptyRegistry: WorkflowRegistry = {
	get size(): number {
		return 0;
	},
	owners: () => ["t0"],
	repos: (owner) => (owner === "t0" ? ["r0"] : []),
	pairs: () => [{ owner: "t0", repo: "r0" }],
	list: () => [],
	registerOwner: async () => ({ ok: false, error: "unused" }),
	recover: async () => undefined,
	getEntry: () => undefined,
	dispose: () => undefined,
};

const DETAILS_OK_RE = /<details[^>]*id="inv-evt_ok"/;
const DETAILS_ERR_RE = /<details[^>]*id="inv-evt_err"/;
const DETAILS_PENDING_RE = /<details[^>]*id="inv-evt_pending"/;

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return makeEvent({
		id: "evt_a",
		at: "2026-04-16T10:00:00.000Z",
		ts: 0,
		workflow: "wf",
		name: "on-push",
		...overrides,
	});
}

// Events written via makeEvent() carry owner "t0" + repo "r0" by default;
// inject a user whose orgs include "t0" so the scoped query returns the
// seeded rows.
const TEST_USER: UserContext = {
	login: "user",
	mail: "user@example.test",
	orgs: ["t0", "user"],
};

async function mount(
	eventStore: EventStore,
	user: UserContext = TEST_USER,
): Promise<Hono> {
	const app = new Hono();
	const injectUser = async (c: any, next: () => Promise<void>) => {
		c.set("user", user);
		await next();
	};
	const m = dashboardMiddleware({
		eventStore,
		registry: emptyRegistry,
		sessionMw: injectUser,
	});
	const noopNext = async () => {
		/* no-op */
	};
	app.use("*", async (c) => {
		const res = await m.handler(c, noopNext);
		return res ?? c.text("unhandled", 404);
	});
	return app;
}

const AUTH_HEADERS = {};

describe("dashboard middleware — root tree", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("renders the owner tree with HTMX lazy-load hooks", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('class="tree-owners"');
		// Lazy-loading hook for the owner's repo list
		expect(html).toContain('hx-get="/dashboard/t0/repos"');
	});
});

describe("dashboard middleware — invocations fragment", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("renders an empty state when there are no invocations", async () => {
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("No invocations yet");
	});

	it("renders a card with status=pending for an invocation with no terminal event", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toContain("on-push");
		expect(html).toContain("pending");
	});

	it("derives status=succeeded from trigger.response", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		await store.handle(
			event({
				kind: "trigger.response",
				seq: 1,
				ref: 0,
				output: { status: 200 },
				at: "2026-04-16T10:00:01.000Z",
				ts: 1_000_000,
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toContain("succeeded");
	});

	it("derives status=failed from trigger.error", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		await store.handle(
			event({
				kind: "trigger.error",
				seq: 1,
				ref: 0,
				error: { message: "boom", stack: "" },
				at: "2026-04-16T10:00:01.000Z",
				ts: 1_000_000,
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toContain("failed");
	});

	it("orders by at desc", async () => {
		await Promise.all(
			[0, 1, 2].map((i) =>
				store.handle(
					event({
						id: `evt_${i}`,
						kind: "trigger.request",
						seq: 0,
						at: `2026-04-16T10:00:0${i}.000Z`,
						name: `tr_${i}`,
					}),
				),
			),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html.indexOf("tr_2")).toBeLessThan(html.indexOf("tr_0"));
	});

	it("succeeded row is expandable with HTMX lazy-load attributes", async () => {
		await store.handle(
			event({ id: "evt_ok", kind: "trigger.request", seq: 0, name: "t_ok" }),
		);
		await store.handle(
			event({
				id: "evt_ok",
				kind: "trigger.response",
				seq: 1,
				ref: 0,
				output: { status: 200 },
				at: "2026-04-16T10:00:01.000Z",
				ts: 1_000_000,
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toMatch(DETAILS_OK_RE);
		expect(html).toContain(
			'hx-get="/dashboard/t0/r0/invocations/evt_ok/flamegraph"',
		);
		expect(html).toContain('hx-trigger="toggle once"');
		expect(html).toContain('hx-target="find .flame-slot"');
		expect(html).toContain('class="flame-slot"');
	});

	it("failed row is expandable with the same HTMX attributes", async () => {
		await store.handle(
			event({ id: "evt_err", kind: "trigger.request", seq: 0, name: "t_err" }),
		);
		await store.handle(
			event({
				id: "evt_err",
				kind: "trigger.error",
				seq: 1,
				ref: 0,
				error: { message: "nope", stack: "" },
				at: "2026-04-16T10:00:01.000Z",
				ts: 1_000_000,
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toMatch(DETAILS_ERR_RE);
		expect(html).toContain(
			'hx-get="/dashboard/t0/r0/invocations/evt_err/flamegraph"',
		);
	});

	it("pending row has no expand affordance (no details, no hx-get flamegraph)", async () => {
		await store.handle(
			event({
				id: "evt_pending",
				kind: "trigger.request",
				seq: 0,
				name: "t_p",
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/r0/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).not.toMatch(DETAILS_PENDING_RE);
		expect(html).not.toContain(
			"/dashboard/t0/r0/invocations/evt_pending/flamegraph",
		);
		expect(html).toContain('id="inv-evt_pending"');
	});
});

describe("dashboard middleware — auth scoping", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("returns 404 for an owner the user is not a member of", async () => {
		const app = await mount(store);
		const res = await app.request("/dashboard/other/r0", {
			headers: AUTH_HEADERS,
		});
		expect(res.status).toBe(404);
	});

	it("returns 404 for a malformed repo identifier", async () => {
		const app = await mount(store);
		const res = await app.request("/dashboard/t0/bad%20repo", {
			headers: AUTH_HEADERS,
		});
		expect(res.status).toBe(404);
	});
});
