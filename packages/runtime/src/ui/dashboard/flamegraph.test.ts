import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { describe, expect, it } from "vitest";
import { renderFlamegraph } from "./flamegraph.js";

const ACTION_20_40_RE =
	/kind-action[^"]*"[^>]* x="20\.\d+%"[^>]* width="40\.\d+%"/;
const REST_MIN_WIDTH_RE =
	/kind-rest[^"]*"[^>]* x="10\.\d+%"[^>]* width="(\d+\.\d+)%"/;
const ACTION_ORPHAN_RE =
	/kind-action[^"]*orphan[^"]*"[^>]* x="20\.\d+%"[^>]* width="80\.\d+%"/;
const CONNECTOR_RE = /class="timer-connector"/g;
const CONNECTOR_ID_9_RE = /class="timer-connector"[^>]*data-timer-id="9"/g;
const CONNECTOR_ID_7_RE = /class="timer-connector"[^>]*data-timer-id="7"/;
const CONNECTOR_ID_9_ONE_RE = /class="timer-connector"[^>]*data-timer-id="9"/;
const TIMER_BAR_ID_7_RE = /kind-rest[^"]*"[^>]*data-timer-id="7"/;
const TIMER_BAR_ID_9_RE = /kind-rest[^"]*"[^>]*data-timer-id="9"/;
const TIMER_Y_RE =
	/kind-rest[^"]*"[^>]* x="[^"]*" y="(\d+)"[^>]*data-timer-id="\d+"/g;
const FETCH_REST_RE = /kind-rest[^"]*"[^>]* x="20\.\d+%"[^>]* width="20\.\d+%"/;
const WASI_MARKER_CIRCLE_RE = /class="marker-call"[^>]*data-event-seq="2"/;
const DURATION_1MS_RE = /1\.0 ms/;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function req(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind" | "seq">,
): InvocationEvent {
	return makeEvent({ id: "evt_a", ...overrides });
}

// reqOpen widens the `kind` field so tests can simulate plugin-era prefixes
// (fetch.*, wasi.*) that are outside core's closed `EventKind` union.
function reqOpen(
	overrides: Partial<Omit<InvocationEvent, "kind">> & {
		kind: string;
		seq: number;
	},
): InvocationEvent {
	const { kind, ...rest } = overrides;
	return makeEvent({
		id: "evt_a",
		...rest,
		kind: kind as InvocationEvent["kind"],
	});
}

async function html(fragment: unknown): Promise<string> {
	return (await (fragment as any)).toString();
}

// ---------------------------------------------------------------------------
// Empty-state
// ---------------------------------------------------------------------------

describe("renderFlamegraph — empty state", () => {
	it("returns flame-empty fragment for empty event list", async () => {
		const out = await html(renderFlamegraph([]));
		expect(out).toContain('class="flame-empty"');
		expect(out).not.toContain("<svg");
	});

	it("returns flame-empty fragment when trigger.request is missing", async () => {
		const out = await html(
			renderFlamegraph([req({ kind: "action.request", seq: 1, ref: 0 })]),
		);
		expect(out).toContain('class="flame-empty"');
		expect(out).not.toContain('<svg class="flame-graph"');
	});

	it("returns flame-empty fragment for pending invocation (no terminal)", async () => {
		const out = await html(
			renderFlamegraph([req({ kind: "trigger.request", seq: 0, ts: 0 })]),
		);
		expect(out).toContain('class="flame-empty"');
		expect(out).not.toContain('<svg class="flame-graph"');
	});
});

// ---------------------------------------------------------------------------
// Canonical tree
// ---------------------------------------------------------------------------

describe("renderFlamegraph — canonical tree", () => {
	it("renders trigger → action → system as nested bars with kind classes", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0, name: "webhook" }),
			req({
				kind: "action.request",
				seq: 1,
				ref: 0,
				ts: 200,
				name: "sendEmail",
			}),
			req({
				kind: "system.request",
				seq: 2,
				ref: 1,
				ts: 300,
				name: "host.fetch",
			}),
			req({
				kind: "system.response",
				seq: 3,
				ref: 2,
				ts: 500,
				name: "host.fetch",
			}),
			req({
				kind: "action.response",
				seq: 4,
				ref: 1,
				ts: 700,
				name: "sendEmail",
			}),
			req({
				kind: "trigger.response",
				seq: 5,
				ref: 0,
				ts: 1000,
				name: "webhook",
			}),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain('class="flame-graph"');
		expect(out).toContain("kind-trigger");
		expect(out).toContain("kind-action");
		expect(out).toContain("kind-rest");
		// The invocation card wrapping this fragment already surfaces
		// workflow/trigger/duration/status — the flamegraph header only
		// adds per-kind counts (zero counts are suppressed).
		expect(out).toContain("sendEmail"); // action name inside bar label
		expect(out).toContain("1</strong> action");
		expect(out).toContain("1</strong> host call");
	});

	it("bar x% and width% reflect monotonic ts proportions", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 200, name: "a" }),
			req({ kind: "action.response", seq: 2, ref: 1, ts: 600, name: "a" }),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 1000 }),
		];
		const out = await html(renderFlamegraph(events));
		// Action bar should be at 20% and 40% wide.
		expect(out).toMatch(ACTION_20_40_RE);
	});

	it("sub-µs bar receives minimum width floor", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "system.request", seq: 1, ref: 0, ts: 100, name: "h" }),
			req({ kind: "system.response", seq: 2, ref: 1, ts: 100, name: "h" }),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 1000 }),
		];
		const out = await html(renderFlamegraph(events));
		// min width floor is 4/1000 * 100 = 0.4%
		const match = out.match(REST_MIN_WIDTH_RE);
		expect(match).not.toBeNull();
		if (match) {
			expect(Number(match[1])).toBeGreaterThanOrEqual(0.4);
		}
	});
});

// ---------------------------------------------------------------------------
// Orphan
// ---------------------------------------------------------------------------

describe("renderFlamegraph — orphan", () => {
	it("renders orphan class and extends bar to trigger.error.ts", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 100, name: "stuck" }),
			// No action.response — the action was in-flight when engine crashed.
			req({
				kind: "trigger.error",
				seq: 2,
				ref: 0,
				ts: 500,
				error: { message: "engine_crashed", stack: "" },
			}),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("orphan");
		// The action bar should end at trigger.error.ts (ts=500 / 500 = 100%).
		// x=20%, width=80%.
		expect(out).toMatch(ACTION_ORPHAN_RE);
	});
});

// ---------------------------------------------------------------------------
// Errored
// ---------------------------------------------------------------------------

describe("renderFlamegraph — errored", () => {
	it("failed action bar carries bar-error class and error icon", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 100, name: "boom" }),
			req({
				kind: "action.error",
				seq: 2,
				ref: 1,
				ts: 300,
				name: "boom",
				error: { message: "nope", stack: "" },
			}),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("bar-error");
		expect(out).toContain("⚠");
	});
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

describe("renderFlamegraph — setTimeout fires once", () => {
	it("produces exactly one connector from the set marker to the timer bar", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 100, name: "sched" }),
			req({
				kind: "timer.set",
				seq: 2,
				ref: 1,
				ts: 150,
				name: "setTimeout",
				input: { timerId: 7, delay: 100 },
			}),
			req({ kind: "action.response", seq: 3, ref: 1, ts: 200, name: "sched" }),
			req({
				kind: "timer.request",
				seq: 4,
				ref: null,
				ts: 300,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({
				kind: "timer.response",
				seq: 5,
				ref: 4,
				ts: 400,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({ kind: "trigger.response", seq: 6, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		const matches = out.match(CONNECTOR_RE);
		expect(matches).not.toBeNull();
		expect(matches?.length).toBe(1);
		expect(out).toContain('data-timer-id="7"');
		expect(out).toContain("kind-rest");
		// Compact header metrics include a timer count when nonzero.
		expect(out).toContain("1</strong> timer");
	});
});

describe("renderFlamegraph — setInterval fires 3x", () => {
	it("produces three connectors from one set marker", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 50, name: "sched" }),
			req({
				kind: "timer.set",
				seq: 2,
				ref: 1,
				ts: 60,
				name: "setInterval",
				input: { timerId: 9, delay: 100 },
			}),
			req({ kind: "action.response", seq: 3, ref: 1, ts: 70, name: "sched" }),
			// Three fires of id=9.
			req({
				kind: "timer.request",
				seq: 4,
				ref: null,
				ts: 160,
				name: "setInterval",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.response",
				seq: 5,
				ref: 4,
				ts: 170,
				name: "setInterval",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.request",
				seq: 6,
				ref: null,
				ts: 270,
				name: "setInterval",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.response",
				seq: 7,
				ref: 6,
				ts: 280,
				name: "setInterval",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.request",
				seq: 8,
				ref: null,
				ts: 380,
				name: "setInterval",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.response",
				seq: 9,
				ref: 8,
				ts: 390,
				name: "setInterval",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.clear",
				seq: 10,
				ref: 0,
				ts: 450,
				name: "clearInterval",
				input: { timerId: 9 },
			}),
			req({ kind: "trigger.response", seq: 11, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		const matches = out.match(CONNECTOR_RE);
		expect(matches?.length).toBe(3);
		// All connectors carry the same timer-id
		const idMatches = out.match(CONNECTOR_ID_9_RE);
		expect(idMatches?.length).toBe(3);
		// Clear marker is rendered
		expect(out).toContain("marker-clear-bg");
		expect(out).toContain('class="marker-x"');
	});
});

describe("renderFlamegraph — unpaired set", () => {
	it("produces zero connectors when the set was cleared before firing", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({
				kind: "timer.set",
				seq: 1,
				ref: 0,
				ts: 100,
				name: "setTimeout",
				input: { timerId: 11, delay: 300 },
			}),
			req({
				kind: "timer.clear",
				seq: 2,
				ref: 0,
				ts: 150,
				name: "clearTimeout",
				input: { timerId: 11 },
			}),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).not.toContain('class="timer-connector"');
		// But both markers render
		expect(out).toContain("marker-set");
		expect(out).toContain("marker-clear-bg");
	});
});

describe("renderFlamegraph — nested timer", () => {
	it("renders a set-marker on the timer-track row and a connector", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 20, name: "outer" }),
			req({
				kind: "timer.set",
				seq: 2,
				ref: 1,
				ts: 40,
				name: "setTimeout",
				input: { timerId: 7, delay: 80 },
			}),
			req({ kind: "action.response", seq: 3, ref: 1, ts: 70, name: "outer" }),
			req({
				kind: "timer.request",
				seq: 4,
				ref: null,
				ts: 120,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			// Nested set inside the outer timer callback.
			req({
				kind: "timer.set",
				seq: 5,
				ref: 4,
				ts: 160,
				name: "setTimeout",
				input: { timerId: 9, delay: 60 },
			}),
			req({
				kind: "timer.response",
				seq: 6,
				ref: 4,
				ts: 300,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({
				kind: "timer.request",
				seq: 7,
				ref: null,
				ts: 220,
				name: "setTimeout",
				input: { timerId: 9 },
			}),
			req({
				kind: "timer.response",
				seq: 8,
				ref: 7,
				ts: 280,
				name: "setTimeout",
				input: { timerId: 9 },
			}),
			req({ kind: "trigger.response", seq: 9, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		// Two connectors, one per timerId
		expect(out).toMatch(CONNECTOR_ID_7_RE);
		expect(out).toMatch(CONNECTOR_ID_9_ONE_RE);
		// Both timer bars carry their ids
		expect(out).toMatch(TIMER_BAR_ID_7_RE);
		expect(out).toMatch(TIMER_BAR_ID_9_RE);
	});
});

describe("renderFlamegraph — concurrent overlap", () => {
	it("overlapping timer bars get distinct rows (different y)", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({
				kind: "timer.set",
				seq: 1,
				ref: 0,
				ts: 30,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({
				kind: "timer.set",
				seq: 2,
				ref: 0,
				ts: 50,
				name: "setTimeout",
				input: { timerId: 8 },
			}),
			req({
				kind: "timer.request",
				seq: 3,
				ref: null,
				ts: 80,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({
				kind: "timer.request",
				seq: 4,
				ref: null,
				ts: 100,
				name: "setTimeout",
				input: { timerId: 8 },
			}),
			req({
				kind: "timer.response",
				seq: 5,
				ref: 4,
				ts: 180,
				name: "setTimeout",
				input: { timerId: 8 },
			}),
			req({
				kind: "timer.response",
				seq: 6,
				ref: 3,
				ts: 240,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({ kind: "trigger.response", seq: 7, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		const yValues = Array.from(out.matchAll(TIMER_Y_RE)).map((m) =>
			Number(m[1]),
		);
		expect(yValues.length).toBe(2);
		expect(yValues[0]).not.toBe(yValues[1]);
	});
});

// ---------------------------------------------------------------------------
// Open-ended prefixes (plugin-era: fetch.*, wasi.*, legacy system.*)
// ---------------------------------------------------------------------------

describe("renderFlamegraph — rest-lane bars", () => {
	it("renders fetch.request/response as a kind-rest bar", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			reqOpen({
				kind: "fetch.request",
				seq: 1,
				ref: 0,
				ts: 200,
				name: "fetch",
			}),
			reqOpen({
				kind: "fetch.response",
				seq: 2,
				ref: 1,
				ts: 400,
				name: "fetch",
			}),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 1000 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("kind-rest");
		// fetch bar spans 200→400 of 0→1000 → x=20%, width=20%.
		expect(out).toMatch(FETCH_REST_RE);
	});

	it("renders legacy system.request/response as a kind-rest bar", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({
				kind: "system.request",
				seq: 1,
				ref: 0,
				ts: 200,
				name: "host.fetch",
			}),
			req({
				kind: "system.response",
				seq: 2,
				ref: 1,
				ts: 400,
				name: "host.fetch",
			}),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 1000 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("kind-rest");
	});

	it("renders timer.request/response as a kind-rest bar", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({
				kind: "timer.request",
				seq: 1,
				ref: null,
				ts: 200,
				name: "setTimeout",
				input: { timerId: 3 },
			}),
			req({
				kind: "timer.response",
				seq: 2,
				ref: 1,
				ts: 400,
				name: "setTimeout",
				input: { timerId: 3 },
			}),
			req({ kind: "trigger.response", seq: 3, ref: 0, ts: 1000 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("kind-rest");
		expect(out).toContain('data-timer-id="3"');
	});
});

describe("renderFlamegraph — open-ended markers", () => {
	it("renders wasi.* leaf event as a marker-call circle", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "action.request", seq: 1, ref: 0, ts: 100, name: "work" }),
			reqOpen({
				kind: "wasi.clock_time_get",
				seq: 2,
				ref: 1,
				ts: 200,
				name: "wasi.clock_time_get",
			}),
			req({ kind: "action.response", seq: 3, ref: 1, ts: 300, name: "work" }),
			req({ kind: "trigger.response", seq: 4, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		// wasi.* is open-ended; it renders as the generic circle marker.
		expect(out).toMatch(WASI_MARKER_CIRCLE_RE);
	});

	it("renders timer.set / timer.clear markers alongside wasi.* markers", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({
				kind: "timer.set",
				seq: 1,
				ref: 0,
				ts: 50,
				name: "setTimeout",
				input: { timerId: 2 },
			}),
			reqOpen({
				kind: "wasi.fd_write",
				seq: 2,
				ref: 0,
				ts: 100,
				name: "wasi.fd_write",
			}),
			req({
				kind: "timer.clear",
				seq: 3,
				ref: 0,
				ts: 150,
				name: "clearTimeout",
				input: { timerId: 2 },
			}),
			req({ kind: "trigger.response", seq: 4, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("marker-set");
		expect(out).toContain("marker-clear-bg");
		expect(out).toContain("marker-call");
	});
});

// ---------------------------------------------------------------------------
// Fragment structure
// ---------------------------------------------------------------------------

describe("renderFlamegraph — fragment structure", () => {
	it("includes flame-events script with JSON and flame-container wrapper", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({ kind: "trigger.response", seq: 1, ref: 0, ts: 1000 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain('class="flame-fragment"');
		expect(out).toContain('class="flame-container"');
		expect(out).toContain('class="flame-events"');
		expect(out).toContain('<script type="application/json"');
		// Ruler renders with at least four tick labels + the total
		expect(out).toContain("0 µs");
		expect(out).toMatch(DURATION_1MS_RE); // 1000 µs total rendered as smart-unit "1.0 ms"
	});

	it("renders track divider and label when timer events exist", async () => {
		const events: InvocationEvent[] = [
			req({ kind: "trigger.request", seq: 0, ts: 0 }),
			req({
				kind: "timer.set",
				seq: 1,
				ref: 0,
				ts: 100,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({
				kind: "timer.request",
				seq: 2,
				ref: null,
				ts: 200,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({
				kind: "timer.response",
				seq: 3,
				ref: 2,
				ts: 300,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			req({ kind: "trigger.response", seq: 4, ref: 0, ts: 500 }),
		];
		const out = await html(renderFlamegraph(events));
		expect(out).toContain("flame-track-divider");
		expect(out).toContain("TIMER CALLBACKS");
	});
});
