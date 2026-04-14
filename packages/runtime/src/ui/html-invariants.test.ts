import { describe, expect, it } from "vitest";
import { renderEntryList, renderHeaderStats } from "./dashboard/list.js";
import { renderPage as renderDashboardPage } from "./dashboard/page.js";
import type {
	CorrelationSummary,
	HeaderStats,
	TimelineEvent,
} from "./dashboard/queries.js";
import { renderTimeline } from "./dashboard/timeline.js";
import { renderTriggerPage } from "./trigger/page.js";

async function render(value: unknown): Promise<string> {
	return String(await Promise.resolve(value));
}

const INLINE_HANDLER_ATTR = /\son[a-z]+="/i;
const INLINE_STYLE_BLOCK = /<style[\s>]/i;
const INLINE_STYLE_ATTR = /\sstyle="/i;
const X_DATA_ATTR = /x-data="([^"]*)"/g;
const COLON_STYLE_ATTR = /:style="([^"]*)"/g;
const BARE_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const DATA_TIP_ATTR = /data-tip="/;

function findCspViolations(body: string): string[] {
	const violations: string[] = [];
	if (INLINE_HANDLER_ATTR.test(body)) {
		violations.push("inline on*= handler attribute");
	}
	if (INLINE_STYLE_BLOCK.test(body)) {
		violations.push("inline <style> block");
	}
	if (INLINE_STYLE_ATTR.test(body)) {
		violations.push("inline style= attribute");
	}
	for (const match of body.matchAll(X_DATA_ATTR)) {
		const value = match[1] ?? "";
		if (!BARE_IDENTIFIER.test(value)) {
			violations.push(`x-data not bare identifier: ${value}`);
		}
	}
	for (const match of body.matchAll(COLON_STYLE_ATTR)) {
		const value = (match[1] ?? "").trim();
		if (!value.startsWith("{")) {
			violations.push(`:style not object form: ${value}`);
		}
	}
	return violations;
}

function makeSummary(
	overrides: Partial<CorrelationSummary> = {},
): CorrelationSummary {
	return {
		correlationId: "corr_1",
		initialEventType: "test.event",
		aggregateState: "done",
		eventCount: 3,
		lastEventAt: "2025-01-01T10:00:00Z",
		...overrides,
	};
}

function makeTimelineEvent(
	overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
	return {
		id: "evt_1",
		type: "test.event",
		state: "done",
		result: "succeeded",
		correlationId: "corr_1",
		parentEventId: null,
		targetAction: null,
		payload: { foo: "bar" },
		error: null,
		logs: null,
		createdAt: "2025-01-01T10:00:00Z",
		emittedAt: "2025-01-01T10:00:00Z",
		startedAt: null,
		doneAt: null,
		...overrides,
	};
}

describe("CSP-safe HTML invariants", () => {
	it("dashboard page has no inline handlers, styles, or free-form x-data", async () => {
		const body = await render(renderDashboardPage("user", "user@example.com"));
		expect(findCspViolations(body)).toEqual([]);
	});

	it("dashboard entry list has no inline handlers or styles", async () => {
		const body = await render(
			renderEntryList(
				[makeSummary(), makeSummary({ correlationId: "corr_2" })],
				null,
				new URLSearchParams(),
			),
		);
		expect(findCspViolations(body)).toEqual([]);
	});

	it("dashboard header stats use data-color, not inline style", async () => {
		const stats: HeaderStats = { pending: 1, failed: 2, done: 3 };
		const body = await render(renderHeaderStats(stats));
		expect(findCspViolations(body)).toEqual([]);
		expect(body).toContain('data-color="yellow"');
		expect(body).toContain('data-color="red"');
		expect(body).toContain('data-color="green"');
	});

	it("dashboard timeline uses discrete data attrs and method-call handlers", async () => {
		const events: TimelineEvent[] = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({
				id: "e2",
				parentEventId: "e1",
				targetAction: "parseOrder",
			}),
		];
		const body = await render(renderTimeline(events));
		expect(findCspViolations(body)).toEqual([]);
		expect(body).toContain('data-type="test.event"');
		expect(body).toContain('data-state="done"');
		expect(body).toContain('data-color="green"');
		expect(body).toContain('@mouseenter="showTip($el)"');
		expect(body).toContain('@mouseleave="scheduleHide()"');
		expect(body).not.toMatch(DATA_TIP_ATTR);
	});

	it("trigger page uses data-event-type + external CSS, not inline handlers", async () => {
		const schemas = {
			"order.received": {
				type: "object",
				properties: { id: { type: "string" } },
			},
		};
		const body = await render(
			renderTriggerPage(schemas, "user", "user@example.com"),
		);
		expect(findCspViolations(body)).toEqual([]);
		expect(body).toContain('data-event-type="order.received"');
		expect(body).toContain('href="/static/trigger.css"');
	});

	it("layout loads dashboard-alpine.js before alpine.js for alpine:init ordering", async () => {
		const body = await render(renderDashboardPage("u", "e"));
		const dashAlpineIdx = body.indexOf("/static/dashboard-alpine.js");
		const alpineIdx = body.indexOf("/static/alpine.js");
		expect(dashAlpineIdx).toBeGreaterThan(-1);
		expect(alpineIdx).toBeGreaterThan(dashAlpineIdx);
	});
});
