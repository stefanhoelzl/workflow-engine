import type { InvocationEvent } from "@workflow-engine/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createEventStore,
	type EventStore,
} from "../../event-bus/event-store.js";
import { dashboardMiddleware } from "./middleware.js";

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		ts: Date.parse("2026-04-16T10:00:00Z"),
		workflow: "wf",
		workflowSha: "sha",
		name: "on-push",
		...overrides,
	} as InvocationEvent;
}

async function mount(eventStore: EventStore): Promise<Hono> {
	const app = new Hono();
	const m = dashboardMiddleware({ eventStore });
	const noopNext = async () => {
		/* no-op */
	};
	app.use("*", async (c) => {
		const res = await m.handler(c, noopNext);
		return res ?? c.text("unhandled", 404);
	});
	return app;
}

describe("dashboard middleware", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("renders an empty state when there are no invocations", async () => {
		const app = await mount(store);
		const res = await app.request("/dashboard");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("No invocations yet");
	});

	it("renders a row with status=pending for an invocation with no terminal event", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard");
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
				ts: Date.parse("2026-04-16T10:00:01Z"),
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard");
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
				ts: Date.parse("2026-04-16T10:00:01Z"),
			}),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard");
		const html = await res.text();
		expect(html).toContain("failed");
	});

	it("orders by ts desc and limits", async () => {
		// 3 invocations, oldest first
		await Promise.all(
			[0, 1, 2].map((i) =>
				store.handle(
					event({
						id: `evt_${i}`,
						kind: "trigger.request",
						seq: 0,
						ts: Date.parse(`2026-04-16T10:00:0${i}Z`),
						name: `tr_${i}`,
					}),
				),
			),
		);
		const app = await mount(store);
		const res = await app.request("/dashboard");
		const html = await res.text();
		// most recent first → tr_2 appears before tr_0 in the rendered HTML
		expect(html.indexOf("tr_2")).toBeLessThan(html.indexOf("tr_0"));
	});
});
