import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createEventStore } from "../../event-bus/event-store.js";
import { createEventBus } from "../../event-bus/index.js";
import { dashboardMiddleware } from "./middleware.js";

function mount(eventStore: Awaited<ReturnType<typeof createEventStore>>) {
	const m = dashboardMiddleware({ eventStore });
	const app = new Hono();
	app.all(m.match, m.handler);
	if (m.match.endsWith("/*")) {
		app.all(m.match.slice(0, -2), m.handler);
	}
	return app;
}

describe("dashboardMiddleware", () => {
	it("renders an empty-state when there are no invocations", async () => {
		const eventStore = await createEventStore();
		await eventStore.initialized;

		const app = mount(eventStore);
		const res = await app.request("/dashboard/");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("Dashboard");
		expect(body).toContain("No invocations yet");
	});

	it("renders rows for completed and failed invocations", async () => {
		const eventStore = await createEventStore();
		await eventStore.initialized;
		const bus = createEventBus([eventStore]);

		const start = new Date("2026-04-15T10:00:00.000Z");
		const end = new Date("2026-04-15T10:00:00.150Z");
		await bus.emit({
			kind: "started",
			id: "evt_a",
			workflow: "cronitor",
			trigger: "cronitorWebhook",
			ts: start,
			input: {},
		});
		await bus.emit({
			kind: "completed",
			id: "evt_a",
			workflow: "cronitor",
			trigger: "cronitorWebhook",
			ts: end,
			result: { status: 202, body: "", headers: {} },
		});
		await bus.emit({
			kind: "started",
			id: "evt_b",
			workflow: "cronitor",
			trigger: "cronitorWebhook",
			ts: start,
			input: {},
		});
		await bus.emit({
			kind: "failed",
			id: "evt_b",
			workflow: "cronitor",
			trigger: "cronitorWebhook",
			ts: end,
			error: { message: "boom" },
		});

		const app = mount(eventStore);
		const res = await app.request("/dashboard/");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("cronitor");
		expect(body).toContain("cronitorWebhook");
		expect(body).toContain("succeeded");
		expect(body).toContain("failed");
		expect(body).toContain("150ms");
	});

	it("orders invocations by startedAt descending", async () => {
		const eventStore = await createEventStore();
		await eventStore.initialized;
		const bus = createEventBus([eventStore]);

		await bus.emit({
			kind: "started",
			id: "evt_old",
			workflow: "wf_old",
			trigger: "tg",
			ts: new Date("2026-04-14T10:00:00.000Z"),
			input: {},
		});
		await bus.emit({
			kind: "started",
			id: "evt_new",
			workflow: "wf_new",
			trigger: "tg",
			ts: new Date("2026-04-15T10:00:00.000Z"),
			input: {},
		});

		const app = mount(eventStore);
		const res = await app.request("/dashboard/");
		const body = await res.text();
		const newIdx = body.indexOf("wf_new");
		const oldIdx = body.indexOf("wf_old");
		expect(newIdx).toBeGreaterThan(-1);
		expect(oldIdx).toBeGreaterThan(newIdx);
	});

	it("shows '—' for the duration of a still-pending invocation", async () => {
		const eventStore = await createEventStore();
		await eventStore.initialized;
		const bus = createEventBus([eventStore]);

		await bus.emit({
			kind: "started",
			id: "evt_pending",
			workflow: "wf",
			trigger: "tg",
			ts: new Date("2026-04-15T10:00:00.000Z"),
			input: {},
		});

		const app = mount(eventStore);
		const res = await app.request("/dashboard/");
		const body = await res.text();
		expect(body).toContain("pending");
		expect(body).toContain("—");
	});
});
