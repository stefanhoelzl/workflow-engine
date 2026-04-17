import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createEventStore,
	type EventStore,
} from "../../event-bus/event-store.js";
import { dashboardMiddleware } from "./middleware.js";

const SUCCEEDED_BADGE_RE = /class="badge succeeded"[^>]*>succeeded</;

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

describe("dashboard middleware — shell", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("renders the loading-state shell without invocation data", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard");
		expect(res.status).toBe(200);
		const html = await res.text();
		// Loading-state skeleton placeholders are present
		expect(html).toContain('class="entry skeleton"');
		// Fragment is wired to load via HTMX
		expect(html).toContain('hx-get="/dashboard/invocations"');
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
		const res = await app.request("/dashboard/invocations");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("No invocations yet");
	});

	it("renders a card with status=pending for an invocation with no terminal event", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		const app = await mount(store);
		const res = await app.request("/dashboard/invocations");
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
		const res = await app.request("/dashboard/invocations");
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
		const res = await app.request("/dashboard/invocations");
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
		const res = await app.request("/dashboard/invocations");
		const html = await res.text();
		// most recent first → tr_2 appears before tr_0 in the rendered HTML
		expect(html.indexOf("tr_2")).toBeLessThan(html.indexOf("tr_0"));
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
		const res = await app.request("/dashboard/invocations");
		const html = await res.text();
		expect(html).toContain('id="inv-evt_success"');
		// Colored status label: badge.succeeded carries the status color + text
		expect(html).toMatch(SUCCEEDED_BADGE_RE);
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
		const res = await app.request("/dashboard/invocations");
		const html = await res.text();
		for (const { expected } of bands) {
			expect(html).toContain(expected);
		}
	});
});
