import { rm } from "node:fs/promises";
import type { InvocationEvent } from "@workflow-engine/core";
import type { SelectQueryBuilder } from "kysely";
import {
	type CteCallback,
	type CteChain,
	createEventStore,
	type Database,
	type EventStore,
	type Scope,
} from "../event-store.js";
import { createTempLibsqlDb } from "./libsql.js";
import { createTestLogger } from "./logger.js";

// Test helper: a minimal `EventStore` whose `record` captures every event in
// an array. Query methods are stubs that throw — tests that need queries
// should use the real `createEventStore` against a temp directory.

interface TestEventStoreOptions {
	readonly onRecord?: (event: InvocationEvent) => void | Promise<void>;
	readonly recordImpl?: (event: InvocationEvent) => Promise<void>;
}

interface TestEventStore extends EventStore {
	readonly recorded: InvocationEvent[];
}

function createTestEventStore(options?: TestEventStoreOptions): TestEventStore {
	const recorded: InvocationEvent[] = [];
	function unsupported(method: string): never {
		throw new Error(
			`TestEventStore.${method}() is a stub — wire a real EventStore for query/ping/with`,
		);
	}
	return {
		recorded,
		async record(event) {
			recorded.push(event);
			if (options?.recordImpl) {
				await options.recordImpl(event);
				return;
			}
			if (options?.onRecord) {
				await options.onRecord(event);
			}
		},
		prune() {
			return Promise.resolve(0);
		},
		query(
			_scopes: readonly Scope[],
		): SelectQueryBuilder<Database, "events", object> {
			return unsupported("query");
		},
		hasUploadEvent() {
			return Promise.resolve(false);
		},
		ping() {
			return Promise.resolve();
		},
		with(_name: string, _fn: CteCallback): CteChain {
			return unsupported("with");
		},
		drainAndClose() {
			return Promise.resolve();
		},
	};
}

interface RealEventStoreHandle {
	store: EventStore;
	dispose: () => Promise<void>;
}

// Boots a real EventStore against a temp libSQL `file:` database. On dispose,
// the store drains, the client closes, and the temp directory is removed.
// Suitable for integration-style tests that need real Kysely queries against
// the events table.
async function createRealEventStoreForTest(): Promise<RealEventStoreHandle> {
	const tmp = await createTempLibsqlDb<Database>();
	const store = await createEventStore({
		db: tmp.db,
		logger: createTestLogger(),
		config: {
			commitMaxRetries: 0,
			commitBackoffMs: 0,
			sigtermFlushTimeoutMs: 5000,
			retentionDays: 0,
		},
	});
	return {
		store,
		dispose: async () => {
			// drainAndClose destroys the Kysely handle (no-op on the injected
			// client); tmp.dispose then closes the client and removes the dir.
			await store.drainAndClose();
			tmp.client.close();
			await rm(tmp.dir, { recursive: true, force: true });
		},
	};
}

export type { RealEventStoreHandle, TestEventStore, TestEventStoreOptions };
export { createRealEventStoreForTest, createTestEventStore };
