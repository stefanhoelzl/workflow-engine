import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import { createEventStore, type EventStore } from "./event-store.js";

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

describe("event store", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("inserts a row for each handled event", async () => {
		await store.handle(event({ kind: "trigger.request", input: { x: 1 } }));
		const rows = await store.query("t0").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "evt_a",
			seq: 0,
			kind: "trigger.request",
			ref: null,
			owner: "t0",
			workflow: "wf",
			workflowSha: "sha",
			name: "on-push",
		});
	});

	it("query(owner) scopes results to that owner", async () => {
		await store.handle(
			event({ kind: "trigger.request", seq: 0, id: "evt_a", owner: "acme" }),
		);
		await store.handle(
			event({
				kind: "trigger.request",
				seq: 0,
				id: "evt_b",
				owner: "contoso",
			}),
		);
		await store.handle(
			event({ kind: "trigger.request", seq: 0, id: "evt_c", owner: "acme" }),
		);
		const rows = await store.query("acme").selectAll().execute();
		expect(rows.map((r) => r.id).sort()).toEqual(["evt_a", "evt_c"]);
	});

	it("query(owner) returns no rows for a owner the caller is not in", async () => {
		await store.handle(
			event({ kind: "trigger.request", seq: 0, id: "evt_x", owner: "other" }),
		);
		const rows = await store
			.query("t0")
			.where("id", "=", "evt_x")
			.selectAll()
			.execute();
		expect(rows).toEqual([]);
	});

	it("appends rows — does not update on subsequent emits", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		await store.handle(
			event({ kind: "trigger.response", seq: 1, ref: 0, output: "ok" }),
		);
		const rows = await store
			.query("t0")
			.selectAll()
			.orderBy("seq", "asc")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.kind)).toEqual([
			"trigger.request",
			"trigger.response",
		]);
	});

	it("rejects duplicate (id, seq) but logs and continues", async () => {
		const logger = { error: vi.fn() };
		const s = await createEventStore({ logger });
		await s.handle(event({ kind: "trigger.request", seq: 0 }));
		await s.handle(event({ kind: "trigger.request", seq: 0 }));
		expect(logger.error).toHaveBeenCalledWith(
			"event-store.insert-failed",
			expect.objectContaining({ id: "evt_a", seq: 0 }),
		);
	});

	it("supports the dashboard summary query (join trigger.request with terminal)", async () => {
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
		await store.handle(
			event({
				id: "evt_b",
				kind: "trigger.request",
				seq: 0,
				name: "another",
				at: "2026-04-16T10:00:02.000Z",
			}),
		);

		const requests = await store
			.query("t0")
			.where("kind", "=", "trigger.request")
			.select(["id", "name"])
			.orderBy("at", "asc")
			.execute();
		expect(requests).toHaveLength(2);
		expect(requests.map((r) => r.id)).toEqual(["evt_a", "evt_b"]);

		const responses = await store
			.query("t0")
			.where("kind", "in", ["trigger.response", "trigger.error"])
			.select(["id", "kind"])
			.execute();
		expect(responses).toHaveLength(1);
		expect(responses[0]?.id).toBe("evt_a");
	});

	it("bootstraps from archived events on init", async () => {
		const dir = await mkdtemp(join(tmpdir(), "event-store-test-"));
		try {
			const backend: StorageBackend = createFsStorage(dir);
			await backend.init();
			const evts: InvocationEvent[] = [
				event({ kind: "trigger.request", seq: 0, input: { hello: "world" } }),
				event({ kind: "trigger.response", seq: 1, ref: 0, output: "ok" }),
			];
			await backend.write(`archive/${evts[0]?.id}.json`, JSON.stringify(evts));

			const s = await createEventStore({ persistence: { backend } });
			await s.initialized;

			const rows = await s
				.query("t0")
				.selectAll()
				.orderBy("seq", "asc")
				.execute();
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.kind)).toEqual([
				"trigger.request",
				"trigger.response",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ping resolves on a healthy store", async () => {
		await expect(store.ping()).resolves.toBeUndefined();
	});

	it("persists meta on trigger.request rows and NULL on other kinds", async () => {
		await store.handle(
			event({
				kind: "trigger.request",
				seq: 0,
				meta: {
					dispatch: {
						source: "manual",
						user: { login: "Jane", mail: "jane@ex.com" },
					},
				},
			}),
		);
		await store.handle(event({ kind: "trigger.response", seq: 1, ref: 0 }));
		const rows = (await store
			.query("t0")
			.select(["kind", "meta"])
			.orderBy("seq", "asc")
			.execute()) as { kind: string; meta: unknown }[];
		expect(rows).toHaveLength(2);
		expect(rows[0]?.kind).toBe("trigger.request");
		const metaRaw = rows[0]?.meta;
		const parsed = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;
		expect(parsed).toEqual({
			dispatch: {
				source: "manual",
				user: { login: "Jane", mail: "jane@ex.com" },
			},
		});
		expect(rows[1]?.kind).toBe("trigger.response");
		expect(rows[1]?.meta).toBeNull();
	});

	it("archive bootstrap tolerates legacy events without meta", async () => {
		const dir = await mkdtemp(join(tmpdir(), "event-store-legacy-"));
		try {
			const backend: StorageBackend = createFsStorage(dir);
			await backend.init();
			const legacy: InvocationEvent[] = [
				event({ kind: "trigger.request", seq: 0, input: { hi: "there" } }),
				event({ kind: "trigger.response", seq: 1, ref: 0, output: "ok" }),
			];
			// Intentionally serialize with meta stripped to simulate pre-change archives.
			const stripped = legacy.map((e) => {
				const { meta: _meta, ...rest } = e as InvocationEvent & {
					meta?: unknown;
				};
				return rest;
			});
			await backend.write(
				`archive/${legacy[0]?.id}.json`,
				JSON.stringify(stripped),
			);

			const s = await createEventStore({ persistence: { backend } });
			await s.initialized;

			const rows = (await s
				.query("t0")
				.select(["seq", "meta"])
				.orderBy("seq", "asc")
				.execute()) as { seq: number; meta: unknown }[];
			expect(rows).toHaveLength(2);
			for (const r of rows) {
				expect(r.meta).toBeNull();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		// in-memory DuckDB instance is GC'd with the store
	});
});
