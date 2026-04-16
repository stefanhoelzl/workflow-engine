import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("writes a pending file per event", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(event({ kind: "system.request", seq: 1, ref: 0 }));

		const pendingPaths: string[] = [];
		for await (const p of backend.list("pending/")) {
			pendingPaths.push(p);
		}
		expect(pendingPaths.sort()).toEqual([
			"pending/evt_a_0.json",
			"pending/evt_a_1.json",
		]);
	});

	it("moves all pending files to archive on terminal trigger.response", async () => {
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

		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive.sort()).toEqual([
			"archive/evt_a/0.json",
			"archive/evt_a/1.json",
			"archive/evt_a/2.json",
			"archive/evt_a/3.json",
		]);
	});

	it("moves to archive on terminal trigger.error", async () => {
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

	it("scanArchive yields events from completed invocations", async () => {
		const c = createPersistence(backend);
		await c.handle(event({ kind: "trigger.request", seq: 0 }));
		await c.handle(
			event({ kind: "trigger.response", seq: 1, ref: 0, output: "ok" }),
		);

		const events: InvocationEvent[] = [];
		for await (const e of scanArchive(backend)) {
			events.push(e);
		}
		expect(events).toHaveLength(2);
		expect(events.find((e) => e.seq === 1)?.kind).toBe("trigger.response");
	});
});
