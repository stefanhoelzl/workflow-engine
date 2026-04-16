import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import { createPersistence, scanArchive, scanPending } from "./persistence.js";

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		ts: 100,
		workflow: "wf",
		workflowSha: "sha",
		name: "on-push",
		...overrides,
	} as InvocationEvent;
}

describe("persistence consumer", () => {
	let dir: string;
	let backend: StorageBackend;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "persistence-test-"));
		backend = createFsStorage(dir);
		await backend.init();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a pending file per event with zero-padded seq", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(event({ kind: "system.request", seq: 1, ref: 0 }));

		const pendingPaths: string[] = [];
		for await (const p of backend.list("pending/")) {
			pendingPaths.push(p);
		}
		expect(pendingPaths.sort()).toEqual([
			"pending/evt_a/000000.json",
			"pending/evt_a/000001.json",
		]);
	});

	it("writes a single archive file containing the JSON array on terminal", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(event({ kind: "system.request", seq: 1, ref: 0 }));
		await c.handle(event({ kind: "system.response", seq: 2, ref: 1 }));
		await c.handle(
			event({
				kind: "trigger.response",
				seq: 3,
				ref: 0,
				output: { status: 200 },
			}),
		);

		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		const archivePaths: string[] = [];
		for await (const p of backend.list("archive/")) {
			archivePaths.push(p);
		}
		expect(archivePaths).toEqual(["archive/evt_a.json"]);

		const content = JSON.parse(await backend.read("archive/evt_a.json"));
		expect(Array.isArray(content)).toBe(true);
		expect(content).toHaveLength(4);
		expect(content.map((e: InvocationEvent) => e.kind)).toEqual([
			"trigger.request",
			"system.request",
			"system.response",
			"trigger.response",
		]);
		expect(content.map((e: InvocationEvent) => e.seq)).toEqual([0, 1, 2, 3]);
	});

	it("archives on terminal trigger.error the same way", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(
			event({
				kind: "trigger.error",
				seq: 1,
				ref: 0,
				error: { message: "boom", stack: "" },
			}),
		);
		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		const archive = JSON.parse(await backend.read("archive/evt_a.json"));
		expect(archive).toHaveLength(2);
		expect(archive[1].kind).toBe("trigger.error");
	});

	it("does not archive on non-terminal events", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(event({ kind: "action.response", seq: 1, ref: 0 }));
		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending.length).toBe(2);

		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive).toEqual([]);
	});

	it("leaves pending and accumulator intact when archive write fails", async () => {
		const logger = { error: vi.fn() };
		const archiveWriteFail: StorageBackend = {
			...backend,
			write: async (path, data) => {
				if (path.startsWith("archive/")) {
					throw new Error("s3 500");
				}
				return backend.write(path, data);
			},
			removePrefix: vi.fn(async () => {
				// must NOT be called when archive write fails
			}),
		};
		const c = createPersistence(archiveWriteFail, { logger });
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(
			event({ kind: "trigger.response", seq: 1, ref: 0, output: "ok" }),
		);

		expect(logger.error).toHaveBeenCalledWith(
			"persistence.archive-failed",
			expect.objectContaining({ id: "evt_a" }),
		);
		expect(archiveWriteFail.removePrefix).not.toHaveBeenCalled();

		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending.sort()).toEqual([
			"pending/evt_a/000000.json",
			"pending/evt_a/000001.json",
		]);
	});

	it("scanPending yields events for crashed invocations", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(
			event({
				kind: "system.request",
				seq: 1,
				ref: 0,
				name: "host.fetch",
			}),
		);
		// Process "crashes" before terminal — pending files remain.
		const events: InvocationEvent[] = [];
		for await (const e of scanPending(backend)) {
			events.push(e);
		}
		expect(events).toHaveLength(2);
		expect(events.map((e) => e.seq).sort()).toEqual([0, 1]);
	});

	it("scanPending parses id and seq from nested padded path", async () => {
		await backend.write(
			"pending/evt_x/000042.json",
			JSON.stringify(event({ id: "evt_x", kind: "trigger.request", seq: 42 })),
		);
		const events: InvocationEvent[] = [];
		for await (const e of scanPending(backend)) {
			events.push(e);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("evt_x");
		expect(events[0]?.seq).toBe(42);
	});

	it("scanArchive yields every event from an archive JSON array", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(event({ kind: "system.request", seq: 1, ref: 0 }));
		await c.handle(event({ kind: "system.response", seq: 2, ref: 1 }));
		await c.handle(
			event({ kind: "trigger.response", seq: 3, ref: 0, output: "ok" }),
		);

		const events: InvocationEvent[] = [];
		for await (const e of scanArchive(backend)) {
			events.push(e);
		}
		expect(events).toHaveLength(4);
		expect(events.map((e) => e.kind)).toEqual([
			"trigger.request",
			"system.request",
			"system.response",
			"trigger.response",
		]);
	});

	it("scanArchive skips malformed archive files", async () => {
		await backend.write("archive/evt_bad.json", "{ not valid json");
		await backend.write(
			"archive/evt_good.json",
			JSON.stringify([event({ kind: "trigger.request", id: "evt_good" })]),
		);

		const events: InvocationEvent[] = [];
		for await (const e of scanArchive(backend)) {
			events.push(e);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("evt_good");
	});
});
