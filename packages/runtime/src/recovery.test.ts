import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BusConsumer,
	createEventBus,
	type InvocationLifecycleEvent,
} from "./event-bus/index.js";
import { createPersistence, pendingPath } from "./event-bus/persistence.js";
import { recover } from "./recovery.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";

let dir: string;
let backend: StorageBackend;

beforeEach(async () => {
	dir = join(tmpdir(), `recovery-test-${crypto.randomUUID()}`);
	await mkdir(dir, { recursive: true });
	backend = createFsStorage(dir);
	await backend.init();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function collector(events: InvocationLifecycleEvent[]): BusConsumer {
	return {
		async handle(event) {
			events.push(event);
		},
	};
}

describe("recover", () => {
	it("sweeps pending records into archive with engine_crashed + emits failed events", async () => {
		// Seed two pending records left behind by a prior session.
		const record1 = {
			id: "evt_crash1",
			workflow: "w1",
			trigger: "t1",
			input: { a: 1 },
			startedAt: "2026-01-01T00:00:00.000Z",
			status: "pending" as const,
		};
		const record2 = {
			id: "evt_crash2",
			workflow: "w1",
			trigger: "t2",
			input: { b: 2 },
			startedAt: "2026-01-01T00:01:00.000Z",
			status: "pending" as const,
		};
		await backend.write(pendingPath(record1.id), JSON.stringify(record1));
		await backend.write(pendingPath(record2.id), JSON.stringify(record2));

		const emitted: InvocationLifecycleEvent[] = [];
		const persistence = createPersistence(backend);
		const bus = createEventBus([persistence, collector(emitted)]);

		await recover({ backend }, bus);

		// All pending files swept away.
		const remainingPending: string[] = [];
		for await (const p of backend.list("pending/")) {
			remainingPending.push(p);
		}
		expect(remainingPending).toEqual([]);

		// Archive contains one failed entry per former pending file.
		const archivePaths: string[] = [];
		for await (const p of backend.list("archive/")) {
			archivePaths.push(p);
		}
		expect(archivePaths.sort()).toEqual(
			["archive/evt_crash1.json", "archive/evt_crash2.json"].sort(),
		);
		for (const path of archivePaths) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential reads keep the assertion loop readable; parallelism here would hide which record failed
			const raw = await backend.read(path);
			const parsed = JSON.parse(raw);
			expect(parsed.status).toBe("failed");
			expect(parsed.error.kind).toBe("engine_crashed");
		}

		// Failed events emitted once per former pending entry.
		expect(emitted.length).toBe(2);
		for (const event of emitted) {
			expect(event.kind).toBe("failed");
			if (event.kind === "failed") {
				expect(event.error.kind).toBe("engine_crashed");
			}
		}
	});

	it("is a no-op for empty pending directory (no events, no errors)", async () => {
		const emitted: InvocationLifecycleEvent[] = [];
		const persistence = createPersistence(backend);
		const bus = createEventBus([persistence, collector(emitted)]);

		await recover({ backend }, bus);
		expect(emitted).toEqual([]);
	});
});
