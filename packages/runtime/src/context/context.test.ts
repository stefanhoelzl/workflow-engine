import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../event-bus/index.js";
import { ActionContext, createActionContext } from "./index.js";

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: "evt_001",
		type: "order.received",
		payload: { orderId: "123" },
		correlationId: "corr_abc",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "orders",
		...overrides,
	} as RuntimeEvent;
}

describe("createActionContext", () => {
	it("returns a factory producing ActionContext values", () => {
		const factory = createActionContext();
		const event = makeEvent();

		const ctx = factory(event, "test-action", { FOO: "bar" });

		expect(ctx).toBeInstanceOf(ActionContext);
		expect(ctx.event).toBe(event);
		expect(ctx.env).toEqual({ FOO: "bar" });
	});

	it("ctx does not have a fetch property", () => {
		const factory = createActionContext();
		const ctx = factory(makeEvent(), "test-action", {});

		expect("fetch" in ctx).toBe(false);
	});

	it("ctx does not have an emit method", () => {
		const factory = createActionContext();
		const ctx = factory(makeEvent(), "test-action", {});

		expect("emit" in ctx).toBe(false);
	});

	it("env only contains declared keys", () => {
		const factory = createActionContext();
		const ctx = factory(makeEvent(), "test-action", { FOO: "bar" });

		expect(Object.keys(ctx.env)).toEqual(["FOO"]);
	});
});
