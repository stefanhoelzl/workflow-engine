import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createEventStore,
	type EventStore,
} from "../../event-bus/event-store.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { dashboardMiddleware } from "./middleware.js";

const emptyRegistry: WorkflowRegistry = {
	runners: [],
	triggerRegistry: {
		register: () => undefined,
		removeRunner: () => undefined,
		lookup: () => undefined,
		list: () => [],
		get size(): number {
			return 0;
		},
	},
	lookupRunner: () => undefined,
	registerTenant: async () => ({ ok: false, error: "unused" }),
	recover: async () => undefined,
	dispose: () => undefined,
};

const SUCCEEDED_BADGE_RE = /class="badge succeeded"[^>]*>succeeded</;
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

async function mount(eventStore: EventStore): Promise<Hono> {
	const app = new Hono();
	const m = dashboardMiddleware({ eventStore, registry: emptyRegistry });
	const noopNext = async () => {
		/* no-op */
	};
	app.use("*", async (c) => {
		const res = await m.handler(c, noopNext);
		return res ?? c.text("unhandled", 404);
	});
	return app;
}

// Events written via makeEvent() carry tenant "t0" by default; auth the
// request as a user whose groups include "t0" so the active-tenant selector
// resolves and the scoped query returns the seeded rows.
// User name is "user" so alphabetical sort of (orgs ∪ {name}) = ["t0","user"]
// → active tenant defaults to "t0", matching the seeded events' default tenant.
const AUTH_HEADERS = {
	"X-Auth-Request-User": "user",
	"X-Auth-Request-Email": "user@example.test",
	"X-Auth-Request-Groups": "t0",
};

describe("dashboard middleware — shell", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("renders the loading-state shell without invocation data", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const html = await res.text();
		// Loading-state skeleton placeholders are present
		expect(html).toContain('class="entry skeleton"');
		// Fragment is wired to load via HTMX
		expect(html).toContain('hx-get="/dashboard/invocations?tenant=t0"');
		expect(html).toContain('hx-trigger="load"');
		// No invocation data is rendered into the shell
		expect(html).not.toContain("on-push");
		expect(html).not.toContain('id="inv-evt_a"');
	});
});

describe("dashboard middleware — fragment", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("renders an empty state when there are no invocations", async () => {
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("No invocations yet");
	});

	it("renders a card with status=pending for an invocation with no terminal event", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations", {
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
		const res = await app.request("/dashboard/invocations", {
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
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toContain("failed");
	});

	it("orders by at desc and limits", async () => {
		// 3 invocations, oldest first
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
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		// most recent first → tr_2 appears before tr_0 in the rendered HTML
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
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toMatch(DETAILS_OK_RE);
		expect(html).toContain('hx-get="/dashboard/invocations/evt_ok/flamegraph"');
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
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toMatch(DETAILS_ERR_RE);
		expect(html).toContain(
			'hx-get="/dashboard/invocations/evt_err/flamegraph"',
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
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).not.toMatch(DETAILS_PENDING_RE);
		expect(html).not.toContain("/dashboard/invocations/evt_pending/flamegraph");
		// But the row is still rendered.
		expect(html).toContain('id="inv-evt_pending"');
	});

	it("renders each invocation with a stable DOM id and status-colored label", async () => {
		await store.handle(
			event({
				id: "evt_success",
				kind: "trigger.request",
				seq: 0,
				name: "t_ok",
			}),
		);
		await store.handle(
			event({
				id: "evt_success",
				kind: "trigger.response",
				seq: 1,
				ref: 0,
				output: { status: 200 },
				at: "2026-04-16T10:00:01.000Z",
				ts: 1_000_000,
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		expect(html).toContain('id="inv-evt_success"');
		// Colored status label: badge.succeeded carries the status color + text
		expect(html).toMatch(SUCCEEDED_BADGE_RE);
	});

	it("flamegraph fragment renders SVG for a completed invocation", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0, ts: 0 }));
		await store.handle(
			event({
				kind: "action.request",
				seq: 1,
				ref: 0,
				ts: 100,
				name: "sendEmail",
			}),
		);
		await store.handle(
			event({
				kind: "action.response",
				seq: 2,
				ref: 1,
				ts: 300,
				name: "sendEmail",
			}),
		);
		await store.handle(
			event({
				kind: "trigger.response",
				seq: 3,
				ref: 0,
				ts: 1000,
				output: { status: 200 },
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations/evt_a/flamegraph");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('class="flame-fragment"');
		expect(html).toContain('class="flame-graph"');
		expect(html).toContain("kind-action");
		expect(html).toContain("sendEmail");
	});

	it("flamegraph fragment returns empty state for unknown id with 200", async () => {
		const app = await mount(store);
		const res = await app.request(
			"/dashboard/invocations/evt_missing/flamegraph",
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('class="flame-empty"');
		expect(html).not.toContain('class="flame-graph"');
	});

	it("flamegraph fragment returns empty state for pending invocation with 200", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0, ts: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations/evt_a/flamegraph");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('class="flame-empty"');
		expect(html).not.toContain('class="flame-graph"');
	});

	it("flamegraph fragment handles URL-encoded ids without 4xx", async () => {
		const app = await mount(store);
		const res = await app.request(
			"/dashboard/invocations/evt_with%20space/flamegraph",
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('class="flame-empty"');
	});

	it("formatDurationUs renders smart-unit bands at the four boundaries", async () => {
		const bands: Array<{ ts: number; expected: string }> = [
			{ ts: 999, expected: "999 µs" },
			{ ts: 1000, expected: "1.0 ms" },
			{ ts: 1_000_000, expected: "1.0 s" },
			{ ts: 60_000_000, expected: "1.0 min" },
		];
		await Promise.all(
			bands.flatMap(({ ts }) => {
				const id = `evt_band_${ts}`;
				return [
					store.handle(
						event({
							id,
							kind: "trigger.request",
							seq: 0,
							at: "2026-04-16T10:00:00.000Z",
							ts: 0,
						}),
					),
					store.handle(
						event({
							id,
							kind: "trigger.response",
							seq: 1,
							ref: 0,
							output: { status: 200 },
							at: "2026-04-16T10:00:01.000Z",
							ts,
						}),
					),
				];
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations", {
			headers: AUTH_HEADERS,
		});
		const html = await res.text();
		for (const { expected } of bands) {
			expect(html).toContain(expected);
		}
	});
});
