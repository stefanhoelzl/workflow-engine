import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { InvocationEvent } from "@workflow-engine/core";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createEventStore,
	type Database,
	type EventStore,
	type EventStoreConfig,
} from "./event-store.js";
import type { Logger } from "./logger.js";
import { openLibsqlDb } from "./test-utils/libsql.js";
import { createTestLogger } from "./test-utils/logger.js";

function defaultConfig(
	overrides: Partial<EventStoreConfig> = {},
): EventStoreConfig {
	return {
		commitMaxRetries: 0,
		commitBackoffMs: 0,
		sigtermFlushTimeoutMs: 5000,
		retentionDays: 0,
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
	let db: Kysely<Database>;
	// Every libSQL client opened during a test (the per-test db plus any reopen)
	// so afterEach can close them all (db.destroy() is a no-op on the injected
	// client; the client owns the file handle).
	let clients: Client[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "event-store-test-"));
		logger = createTestLogger();
		const opened = openLibsqlDb<Database>(dir);
		db = opened.db;
		clients = [opened.client];
	});

	afterEach(async () => {
		await store.drainAndClose();
		for (const client of clients) {
			client.close();
		}
		await rm(dir, { recursive: true, force: true });
	});

	describe("record() and query()", () => {
		it("non-terminal events stay in the in-memory accumulator and are not queryable", async () => {
			store = await createEventStore({
				db,
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
				db,
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

		it("orders by ISO-8601 'at' DESC, id DESC chronologically (string sort == time)", async () => {
			store = await createEventStore({ db, logger, config: defaultConfig() });
			// Distinct invocations whose request `at` spans ms precision and a
			// multi-day gap — lexicographic TEXT order must match chronological.
			const stamps: [string, string][] = [
				["evt_1", "2026-01-01T00:00:00.000Z"],
				["evt_2", "2026-01-01T00:00:00.005Z"],
				["evt_3", "2027-02-05T12:34:56.789Z"],
			];
			for (const [id, at] of stamps) {
				// biome-ignore lint/performance/noAwaitInLoops: seed sequentially so commit order is deterministic
				await store.record(
					makeEvent({ id, kind: "trigger.request", seq: 0, at }),
				);
				await store.record(
					makeEvent({ id, kind: "trigger.response", seq: 1, ref: 0, at }),
				);
			}
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.where("kind", "=", "trigger.request")
				.select(["id", "at"])
				.orderBy("at", "desc")
				.orderBy("id", "desc")
				.execute();
			expect(rows.map((r) => r.id)).toEqual(["evt_3", "evt_2", "evt_1"]);
		});

		it("terminal trigger.error commits identically", async () => {
			store = await createEventStore({
				db,
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
				db,
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
				db,
				logger,
				config: defaultConfig(),
			});
			expect(() => store.query([])).toThrow(/non-empty.*allow-list/);
		});

		it("query() filters by (owner, repo)", async () => {
			store = await createEventStore({
				db,
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
				db,
				logger,
				config: defaultConfig(),
			});
			expect(
				await store.hasUploadEvent("acme", "foo", "demo", "sha-never"),
			).toBe(false);
		});

		it("returns true after a system.upload terminal commit", async () => {
			store = await createEventStore({
				db,
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
				db,
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
				db,
				logger,
				config: defaultConfig(),
			});
			await expect(store.ping()).resolves.toBeUndefined();
		});
	});

	describe("retry-then-drop on commit failure", () => {
		it("happy-path commit emits commit-ok and no retry/drop log lines", async () => {
			store = await createEventStore({
				db,
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
				db,
				logger,
				config: defaultConfig(),
			});
			// trigger.request goes into the accumulator; no terminal yet.
			await store.record(
				makeEvent({ id: "evt_drain", kind: "trigger.request", seq: 0 }),
			);
			// drainAndClose synthesises a trigger.error{shutdown} and commits.
			await store.drainAndClose();
			// Re-open against the same file to query the durable state.
			const reopened = openLibsqlDb<Database>(dir);
			clients.push(reopened.client);
			const reopen = await createEventStore({
				db: reopened.db,
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
				db,
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

	// Commit a complete invocation (request + terminal response) under
	// (acme, foo). `requestAt`/`responseAt` set the wall-clock `at` of each event.
	async function commitInvocation(
		s: EventStore,
		id: string,
		requestAt: string,
		responseAt: string = requestAt,
	): Promise<void> {
		await s.record(
			makeEvent({ id, kind: "trigger.request", seq: 0, at: requestAt }),
		);
		await s.record(
			makeEvent({
				id,
				kind: "trigger.response",
				seq: 1,
				ref: 0,
				at: responseAt,
			}),
		);
	}

	async function distinctIds(s: EventStore): Promise<string[]> {
		const rows = await s
			.query([{ owner: "acme", repo: "foo" }])
			.select("id")
			.distinct()
			.execute();
		return rows.map((r) => r.id).sort();
	}

	describe("prune", () => {
		it("deletes fully-aged invocations, keeps recent ones, returns the invocation count", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig(),
			});
			await commitInvocation(store, "evt_old", "2026-01-01T00:00:00.000Z");
			await commitInvocation(store, "evt_recent", "2026-06-01T00:00:00.000Z");
			const deleted = await store.prune({
				olderThan: new Date("2026-03-01T00:00:00.000Z"),
			});
			expect(deleted).toBe(1);
			expect(await distinctIds(store)).toEqual(["evt_recent"]);
		});

		it("keeps a straddling call graph whole (max(at) newer than cutoff survives)", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig(),
			});
			// request is old, response is recent → max(at) newer than cutoff.
			await commitInvocation(
				store,
				"evt_span",
				"2026-01-01T00:00:00.000Z",
				"2026-06-01T00:00:00.000Z",
			);
			const deleted = await store.prune({
				olderThan: new Date("2026-03-01T00:00:00.000Z"),
			});
			expect(deleted).toBe(0);
			const rows = await store
				.query([{ owner: "acme", repo: "foo" }])
				.where("id", "=", "evt_span")
				.selectAll()
				.execute();
			expect(rows).toHaveLength(2);
		});

		it("is a no-op when nothing is aged", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig(),
			});
			await commitInvocation(store, "evt_recent", "2026-06-01T00:00:00.000Z");
			const deleted = await store.prune({
				olderThan: new Date("2026-01-01T00:00:00.000Z"),
			});
			expect(deleted).toBe(0);
			expect(await distinctIds(store)).toEqual(["evt_recent"]);
		});

		it("returns 0 once the store is stopped", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig(),
			});
			await store.drainAndClose();
			const deleted = await store.prune({ olderThan: new Date() });
			expect(deleted).toBe(0);
		});
	});

	describe("scheduled retention", () => {
		it("schedules nothing when retention is disabled", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig({ retentionDays: 0 }),
			});
			await commitInvocation(
				store,
				"evt_old",
				new Date(Date.now() - 100 * 86_400_000).toISOString(),
			);
			// Give any (non-existent) timer ample time to fire.
			await new Promise((r) => setTimeout(r, 60));
			expect(await distinctIds(store)).toEqual(["evt_old"]);
			expect(logger.info).not.toHaveBeenCalledWith(
				"event-store.prune-ok",
				expect.anything(),
			);
		});

		it("an enabled tick prunes aged invocations and logs prune-ok", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig({ retentionDays: 30 }),
			});
			await commitInvocation(
				store,
				"evt_old",
				new Date(Date.now() - 100 * 86_400_000).toISOString(),
			);
			await commitInvocation(
				store,
				"evt_recent",
				new Date(Date.now() - 1 * 86_400_000).toISOString(),
			);
			await vi.waitFor(() => {
				expect(logger.info).toHaveBeenCalledWith(
					"event-store.prune-ok",
					expect.objectContaining({ invocations: 1 }),
				);
			});
			expect(await distinctIds(store)).toEqual(["evt_recent"]);
		});

		it("a failing scheduled prune logs prune-failed, keeps running, and the timer survives", async () => {
			vi.useFakeTimers();
			try {
				// Interval is derived: retentionDays/100 → 30/100 days.
				const retentionDays = 30;
				const intervalMs = (retentionDays * 86_400_000) / 100;
				store = await createEventStore({
					db,
					logger,
					config: defaultConfig({ retentionDays }),
				});
				// Force scheduled prunes to reject; the scheduler tick calls the
				// public prune, so this exercises the safePrune catch.
				const realPrune = store.prune.bind(store);
				let failures = 0;
				store.prune = vi.fn(() => {
					failures += 1;
					return Promise.reject(new Error("boom"));
				});
				// Deferred first prune (setTimeout 0), then one interval tick.
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(intervalMs);
				// Process still alive and the interval kept firing (>1 attempt).
				expect(failures).toBeGreaterThan(1);
				expect(logger.error).toHaveBeenCalledWith(
					"event-store.prune-failed",
					expect.objectContaining({ error: "boom" }),
				);
				// Restore so afterEach drains a healthy store.
				store.prune = realPrune;
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("retention shutdown safety", () => {
		it("drainAndClose clears the timer and no prune runs afterward", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig({ retentionDays: 30 }),
			});
			await store.drainAndClose();
			const pruneSpy = vi.fn(store.prune);
			store.prune = pruneSpy;
			await new Promise((r) => setTimeout(r, 60));
			expect(pruneSpy).not.toHaveBeenCalled();
		});
	});

	describe("retention durability across reopen", () => {
		it("a committed prune persists; reopening shows only retained invocations", async () => {
			store = await createEventStore({
				db,
				logger,
				config: defaultConfig(),
			});
			await commitInvocation(store, "evt_old", "2026-01-01T00:00:00.000Z");
			await commitInvocation(store, "evt_recent", "2026-06-01T00:00:00.000Z");
			await store.prune({ olderThan: new Date("2026-03-01T00:00:00.000Z") });
			await store.drainAndClose();
			const reopened = openLibsqlDb<Database>(dir);
			clients.push(reopened.client);
			const reopen = await createEventStore({
				db: reopened.db,
				logger,
				config: defaultConfig(),
			});
			try {
				expect(await distinctIds(reopen)).toEqual(["evt_recent"]);
			} finally {
				store = reopen;
			}
		});
	});
});
