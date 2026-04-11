import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "./queries.js";
import { assignPositions, buildTree, type LayoutNode } from "./timeline.js";

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
		payload: {},
		error: null,
		createdAt: "2025-01-01T10:00:00Z",
		emittedAt: "2025-01-01T10:00:00Z",
		startedAt: null,
		doneAt: null,
		...overrides,
	};
}

describe("buildTree", () => {
	it("creates a single root for a root event", () => {
		const events = [makeTimelineEvent({ id: "e1" })];
		const roots = buildTree(events);
		expect(roots).toHaveLength(1);
		expect(roots[0]?.event.id).toBe("e1");
		expect(roots[0]?.children).toHaveLength(0);
	});

	it("links children to parents via parentEventId", () => {
		const events = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({ id: "e2", parentEventId: "e1" }),
			makeTimelineEvent({ id: "e3", parentEventId: "e1" }),
		];
		const roots = buildTree(events);
		expect(roots).toHaveLength(1);
		expect(roots[0]?.children).toHaveLength(2);
		expect(roots[0]?.children[0]?.event.id).toBe("e2");
		expect(roots[0]?.children[1]?.event.id).toBe("e3");
	});

	it("creates a linear chain", () => {
		const events = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({ id: "e2", parentEventId: "e1" }),
			makeTimelineEvent({ id: "e3", parentEventId: "e2" }),
		];
		const roots = buildTree(events);
		expect(roots).toHaveLength(1);
		expect(roots[0]?.children).toHaveLength(1);
		expect(roots[0]?.children[0]?.children).toHaveLength(1);
		expect(roots[0]?.children[0]?.children[0]?.event.id).toBe("e3");
	});
});

describe("assignPositions", () => {
	it("assigns evenly spaced X positions for a linear chain", () => {
		const events = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({ id: "e2", parentEventId: "e1" }),
			makeTimelineEvent({ id: "e3", parentEventId: "e2" }),
		];
		const roots = buildTree(events);
		assignPositions(roots);

		const nodes = flattenTree(roots);
		const xs = nodes.map((n) => n.x);
		expect(xs).toHaveLength(3);
		const spacing1 = (xs[1] ?? 0) - (xs[0] ?? 0);
		const spacing2 = (xs[2] ?? 0) - (xs[1] ?? 0);
		expect(spacing1).toBe(spacing2);
	});

	it("assigns same Y for a linear chain (no branching)", () => {
		const events = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({ id: "e2", parentEventId: "e1" }),
		];
		const roots = buildTree(events);
		assignPositions(roots);

		expect(roots[0]?.y).toBe(roots[0]?.children[0]?.y);
	});

	it("fans out Y for branches", () => {
		const events = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({ id: "e2", parentEventId: "e1" }),
			makeTimelineEvent({ id: "e3", parentEventId: "e1" }),
		];
		const roots = buildTree(events);
		assignPositions(roots);

		const parent = roots[0];
		const child1 = parent?.children[0];
		const child2 = parent?.children[1];

		expect(parent).toBeDefined();
		expect(child1).toBeDefined();
		expect(child2).toBeDefined();
		expect(child1?.y).toBeLessThan(parent?.y ?? 0);
		expect(child2?.y).toBeGreaterThan(parent?.y ?? 0);
	});

	it("returns valid dimensions", () => {
		const events = [
			makeTimelineEvent({ id: "e1" }),
			makeTimelineEvent({ id: "e2", parentEventId: "e1" }),
		];
		const roots = buildTree(events);
		const { width, height } = assignPositions(roots);

		expect(width).toBeGreaterThan(0);
		expect(height).toBeGreaterThan(0);
	});
});

function flattenTree(roots: LayoutNode[]): LayoutNode[] {
	const result: LayoutNode[] = [];
	function walk(node: LayoutNode) {
		result.push(node);
		for (const child of node.children) {
			walk(child);
		}
	}
	for (const root of roots) {
		walk(root);
	}
	return result;
}
