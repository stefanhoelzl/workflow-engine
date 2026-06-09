import { makeEvent } from "@workflow-engine/core/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "../../event-store.js";
import { createRealEventStoreForTest } from "../../test-utils/event-store.js";
import {
	queryTriggerPairs,
	workflowHistoryExists,
} from "./removed-triggers.js";

describe("removed discovery — queryTriggerPairs", () => {
	let store: EventStore;
	let dispose: () => Promise<void>;

	beforeEach(async () => {
		const h = await createRealEventStoreForTest();
		store = h.store;
		dispose = h.dispose;
	});
	afterEach(async () => {
		await dispose();
	});

	it("returns one pair per (workflow, name) regardless of run count", async () => {
		// A persisted invocation needs a terminal event to flush; record the
		// request + response pair for each run.
		const run = async (id: string, name: string) => {
			await store.record(
				makeEvent({
					id,
					kind: "trigger.request",
					seq: 0,
					ref: null,
					workflow: "deploy",
					name,
				}),
			);
			await store.record(
				makeEvent({
					id,
					kind: "trigger.response",
					seq: 1,
					ref: 0,
					workflow: "deploy",
					name,
					output: {},
				}),
			);
		};
		// Two runs of the same trigger "run", plus a second trigger "rollback".
		await run("a1", "run");
		await run("a2", "run");
		await run("b1", "rollback");

		const pairs = await queryTriggerPairs(store, [{ owner: "t0", repo: "r0" }]);
		const keys = pairs.map((p) => `${p.workflow}/${p.name}`).sort();
		expect(keys).toEqual(["deploy/rollback", "deploy/run"]);
	});

	it("does not derive pairs from non-trigger.request events", async () => {
		// A lone system.upload (name = workflow) must not surface as a pair —
		// otherwise (wf, wf) would pollute the tree as a bogus removed trigger.
		await store.record(
			makeEvent({
				id: "u1",
				kind: "system.upload",
				seq: 0,
				ref: 0,
				name: "wf",
			}),
		);
		const pairs = await queryTriggerPairs(store, [{ owner: "t0", repo: "r0" }]);
		expect(pairs).toEqual([]);
	});

	it("returns [] for an empty scope list without querying", async () => {
		expect(await queryTriggerPairs(store, [])).toEqual([]);
	});
});

describe("removed discovery — workflowHistoryExists", () => {
	let store: EventStore;
	let dispose: () => Promise<void>;

	beforeEach(async () => {
		const h = await createRealEventStoreForTest();
		store = h.store;
		dispose = h.dispose;
	});
	afterEach(async () => {
		await dispose();
	});

	it("is true for any historical event of the workflow (incl. synthetic)", async () => {
		await store.record(
			makeEvent({
				id: "x1",
				kind: "system.upload",
				seq: 0,
				ref: 0,
				workflow: "imap-poll",
				name: "imap-poll",
			}),
		);
		expect(await workflowHistoryExists(store, "t0", "r0", "imap-poll")).toBe(
			true,
		);
	});

	it("is false for a workflow with no history", async () => {
		expect(await workflowHistoryExists(store, "t0", "r0", "no-such-wf")).toBe(
			false,
		);
	});
});
