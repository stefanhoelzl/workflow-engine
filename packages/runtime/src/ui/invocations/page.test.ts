import { describe, expect, it } from "vitest";
import { sortInvocationRows } from "./page.js";

type Row = Parameters<typeof sortInvocationRows>[0][number];

function makeRow(overrides: Partial<Row> & Pick<Row, "id">): Row {
	return {
		owner: "t",
		repo: "r",
		workflow: "wf",
		trigger: "tr",
		status: "succeeded",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		startedTs: 0,
		completedTs: 1_000_000,
		...overrides,
	};
}

describe("sortInvocationRows", () => {
	it("sorts terminal rows by startedAt DESC, ignoring per-invocation startedTs", () => {
		// A started earlier (wall-clock) but happens to have a higher
		// startedTs because `ts` is per-invocation monotonic — irrelevant
		// for cross-invocation ordering. B started later (wall-clock).
		// Sort must follow startedAt, not startedTs.
		const a = makeRow({
			id: "A",
			startedAt: "2026-05-03T17:00:00.000Z",
			startedTs: 999,
		});
		const b = makeRow({
			id: "B",
			startedAt: "2026-05-03T18:00:00.000Z",
			startedTs: 0,
		});
		const sorted = sortInvocationRows([a, b]);
		expect(sorted.map((r) => r.id)).toEqual(["B", "A"]);
	});

	it("places pending rows above terminal rows regardless of startedAt", () => {
		const terminal = makeRow({
			id: "term",
			status: "succeeded",
			startedAt: "2026-05-03T18:00:00.000Z",
		});
		const pending = makeRow({
			id: "pend",
			status: "pending",
			startedAt: "2026-05-03T17:00:00.000Z",
			completedTs: null,
		});
		const sorted = sortInvocationRows([terminal, pending]);
		expect(sorted.map((r) => r.id)).toEqual(["pend", "term"]);
	});
});
