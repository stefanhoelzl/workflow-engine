import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventStore,
	type EventStore,
	type EventStoreConfig,
} from "./event-store.js";
import type { Logger } from "./logger.js";
import { createTestLogger } from "./test-utils/logger.js";

function defaultConfig(
	overrides: Partial<EventStoreConfig> = {},
): EventStoreConfig {
	return {
		commitMaxRetries: 0,
		commitBackoffMs: 0,
		sigtermFlushTimeoutMs: 5000,
		...overrides,
	};
}

function makeEvent(overrides: Partial<InvocationEvent>): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		at: "2026-05-01T10:00:00.000Z",
		ts: 0,
		owner: "acme",
		repo: "foo",
		workflow: "demo",
		workflowSha: "0".repeat(64),
		name: "webhook",
		kind: "trigger.request",
		...overrides,
	} as InvocationEvent;
}

describe("EventStore", () => {
	let dir: string;
	let store: EventStore;
	let logger: Logger;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "event-store-test-"));
		logger = createTestLogger();
	});

	afterEach(async () => {
		await store.drainAndClose();
		await rm(dir, { recursive: true, force: true });
	});

	describe("record() and query()", () => {
		it("non-terminal events stay in the in-memory accumulator and are not queryable", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(makeEvent({ kind: "trigger.request", seq: 0 }));
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.selectAll()
				.execute();
			expect(rows).toHaveLength(0);
		});

		it("terminal trigger.response commits the full accumulator", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(makeEvent({ kind: "trigger.request", seq: 0 }));
			await store.record(makeEvent({ kind: "action.request", seq: 1 }));
			await store.record(
				makeEvent({
					kind: "trigger.response",
					seq: 2,
					ref: 0,
					output: { ok: true },
				}),
			);
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.select(["id", "seq", "kind"])
				.orderBy("seq")
				.execute();
			expect(rows).toEqual([
				{ id: "evt_a", seq: 0, kind: "trigger.request" },
				{ id: "evt_a", seq: 1, kind: "action.request" },
				{ id: "evt_a", seq: 2, kind: "trigger.response" },
			]);
		});

		it("terminal trigger.error commits identically", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(makeEvent({ kind: "trigger.request", seq: 0 }));
			await store.record(
				makeEvent({
					kind: "trigger.error",
					seq: 1,
					ref: 0,
					error: { message: "boom" },
				}),
			);
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.select(["seq", "kind"])
				.orderBy("seq")
				.execute();
			expect(rows.map((r) => r.kind)).toEqual([
				"trigger.request",
				"trigger.error",
			]);
		});

		it("single-leaf trigger.exception commits immediately", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(
				makeEvent({
					id: "evt_x",
					kind: "trigger.exception",
					seq: 0,
					error: { message: "boot-failed" },
				}),
			);
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.where("id", "=", "evt_x")
				.select("kind")
				.execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("trigger.exception");
		});

		it("query() with empty scope list throws", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			expect(() => store.query([])).toThrow(/non-empty.*allow-list/);
		});

		it("query() filters by (owner, repo)", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(
				makeEvent({
					id: "evt_a",
					owner: "acme",
					repo: "foo",
					kind: "trigger.request",
					seq: 0,
				}),
			);
			await store.record(
				makeEvent({
					id: "evt_a",
					owner: "acme",
					repo: "foo",
					kind: "trigger.response",
					seq: 1,
					ref: 0,
				}),
			);
			await store.record(
				makeEvent({
					id: "evt_b",
					owner: "acme",
					repo: "bar",
					kind: "trigger.request",
					seq: 0,
				}),
			);
			await store.record(
				makeEvent({
					id: "evt_b",
					owner: "acme",
					repo: "bar",
					kind: "trigger.response",
					seq: 1,
					ref: 0,
				}),
			);
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.select("id")
				.execute();
			expect(rows.every((r) => r.id === "evt_a")).toBe(true);
		});
	});

	describe("hasUploadEvent", () => {
		it("returns false for unknown sha", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			expect(
				await store.hasUploadEvent("acme", "foo", "demo", "sha-never"),
			).toBe(false);
		});

		it("returns true after a system.upload terminal commit", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(
				makeEvent({
					id: "evt_u",
					kind: "system.upload",
					workflowSha: "abc123",
					workflow: "demo",
				}),
			);
			expect(await store.hasUploadEvent("acme", "foo", "demo", "abc123")).toBe(
				true,
			);
		});

		it("does not match cross-(owner, repo)", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(
				makeEvent({
					id: "evt_u",
					kind: "system.upload",
					owner: "acme",
					repo: "foo",
					workflowSha: "abc123",
				}),
			);
			expect(await store.hasUploadEvent("acme", "bar", "demo", "abc123")).toBe(
				false,
			);
		});
	});

	describe("ping", () => {
		it("resolves on a healthy connection", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await expect(store.ping()).resolves.toBeUndefined();
		});
	});

	describe("retry-then-drop on commit failure", () => {
		it("happy-path commit emits commit-ok and no retry/drop log lines", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.record(makeEvent({ kind: "trigger.request", seq: 0 }));
			await store.record(
				makeEvent({ kind: "trigger.response", seq: 1, ref: 0 }),
			);
			expect(logger.warn).not.toHaveBeenCalledWith(
				"event-store.commit-retry",
				expect.anything(),
			);
			expect(logger.error).not.toHaveBeenCalledWith(
				"event-store.commit-dropped",
				expect.anything(),
			);
			expect(logger.info).toHaveBeenCalledWith(
				"event-store.commit-ok",
				expect.objectContaining({ id: "evt_a", rows: 2 }),
			);
		});
	});

	describe("SIGTERM drain", () => {
		it("commits in-flight invocations as trigger.error{kind:'shutdown'}", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			// trigger.request goes into the accumulator; no terminal yet.
			await store.record(
				makeEvent({ id: "evt_drain", kind: "trigger.request", seq: 0 }),
			);
			// drainAndClose synthesises a trigger.error{shutdown} and commits.
			await store.drainAndClose();
			// Re-open against the same dir to query the durable state.
			const reopen = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			try {
				const rows = await reopen
					.query([{ owner: "acme", repo: "foo" }])
					.where("id", "=", "evt_drain")
					.select(["seq", "kind", "error"])
					.orderBy("seq")
					.execute();
				expect(rows).toHaveLength(2);
				expect(rows[0]?.kind).toBe("trigger.request");
				expect(rows[1]?.kind).toBe("trigger.error");
				const rawErr = rows[1]?.error;
				const parsed: { kind?: string; message?: string } =
					typeof rawErr === "string"
						? (JSON.parse(rawErr) as { kind?: string; message?: string })
						: ((rawErr ?? {}) as { kind?: string; message?: string });
				expect(parsed.kind).toBe("shutdown");
			} finally {
				await reopen.drainAndClose();
				// re-bind store so afterEach disposes the original (already
				// drained) without re-attaching the catalog
				store = reopen;
			}
		});

		it("ignores record() after stop and warns", async () => {
			store = await createEventStore({
				persistenceRoot: dir,
				logger,
				config: defaultConfig(),
			});
			await store.drainAndClose();
			await store.record(makeEvent({ kind: "trigger.request", seq: 0 }));
			expect(logger.warn).toHaveBeenCalledWith(
				"event-store.record-after-stop",
				expect.objectContaining({ kind: "trigger.request" }),
			);
		});
	});
});
