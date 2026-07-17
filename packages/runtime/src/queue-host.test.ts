import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQueueHostHandlers } from "./queue-host.js";
import {
	createQueueStore,
	type Database,
	type QueueStore,
} from "./queue-store.js";
import { openMigratedMemoryLibsqlDb } from "./test-utils/libsql.js";
import { createTestLogger } from "./test-utils/logger.js";

// The queue host handlers enforce the partition-key size cap BEFORE any
// statement touches the store (queue.keyTooLarge). Exercised against a real
// libSQL-backed store so the item-size cap is real too.

const BASE = {
	queue: "jobs",
	repo: "foo",
	invocationId: "inv-1",
	triggerKind: "cron",
	triggerName: "tick",
};

describe("queue host handlers — key cap", () => {
	let client: Client;
	let store: QueueStore;
	let put: (args: unknown) => Promise<unknown>;

	beforeEach(async () => {
		const opened = await openMigratedMemoryLibsqlDb<Database>();
		client = opened.client;
		store = await createQueueStore({
			db: opened.db,
			logger: createTestLogger(),
		});
		const handlers = buildQueueHostHandlers({
			owner: "acme",
			workflow: "build",
			validators: new Map(),
			queueStore: store,
		});
		put = handlers["queue.put"] as (args: unknown) => Promise<unknown>;
	});

	afterEach(() => {
		client.close();
	});

	it("accepts a key exactly at the 128-byte cap", async () => {
		await expect(
			put([{ ...BASE, key: "a".repeat(128), item: { x: 1 } }]),
		).resolves.toBeNull();
		expect(
			await store.count({
				owner: "acme",
				repo: "foo",
				workflow: "build",
				queue: "jobs",
			}),
		).toBe(1);
	});

	it("rejects a key over the cap with queue.keyTooLarge and stores nothing", async () => {
		await expect(
			put([{ ...BASE, key: "a".repeat(129), item: { x: 1 } }]),
		).rejects.toMatchObject({ code: "queue.keyTooLarge" });
		expect(
			await store.count({
				owner: "acme",
				repo: "foo",
				workflow: "build",
				queue: "jobs",
			}),
		).toBe(0);
	});

	it("does not count the key against the item-size budget", async () => {
		// ~1010-byte item (≤ 1024) alongside a 100-byte key: both under their
		// independent caps, so the put succeeds.
		const item = { s: "x".repeat(1000) };
		await expect(
			put([{ ...BASE, key: "k".repeat(100), item }]),
		).resolves.toBeNull();
	});
});
