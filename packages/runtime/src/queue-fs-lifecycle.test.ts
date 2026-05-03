import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowManifest } from "@workflow-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "./logger.js";
import {
	applyQueueDiff,
	diffManifests,
	reconcileQueueFiles,
} from "./queue-fs-lifecycle.js";

const noopLogger: Logger = {
	info() {
		/* noop */
	},
	warn() {
		/* noop */
	},
	error() {
		/* noop */
	},
	debug() {
		/* noop */
	},
	trace() {
		/* noop */
	},
	child(): Logger {
		return noopLogger;
	},
};

function manifest(name: string, queueNames: string[]): WorkflowManifest {
	return {
		name,
		module: `${name}.js`,
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
		queues: queueNames.map((q) => ({
			name: q,
			schema: { type: "object" },
		})),
	};
}

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wfe-queue-fs-"));
	return join(root, "queues");
}

describe("diffManifests", () => {
	it("classifies new workflows", () => {
		const result = diffManifests({
			oldWorkflows: new Map(),
			newWorkflows: new Map([["wf", manifest("wf", ["jobs"])]]),
		});
		expect(result.removedWorkflows).toEqual([]);
		expect(result.perWorkflow).toEqual([]);
		expect(result.newWorkflows).toEqual([{ workflow: "wf", queues: ["jobs"] }]);
	});

	it("classifies removed workflows", () => {
		const result = diffManifests({
			oldWorkflows: new Map([["wf", manifest("wf", ["jobs"])]]),
			newWorkflows: new Map(),
		});
		expect(result.removedWorkflows).toEqual(["wf"]);
		expect(result.perWorkflow).toEqual([]);
		expect(result.newWorkflows).toEqual([]);
	});

	it("classifies per-workflow added/removed queues", () => {
		const result = diffManifests({
			oldWorkflows: new Map([["wf", manifest("wf", ["jobs", "old"])]]),
			newWorkflows: new Map([["wf", manifest("wf", ["jobs", "new"])]]),
		});
		expect(result.perWorkflow).toEqual([
			{ workflow: "wf", added: ["new"], removed: ["old"] },
		]);
	});

	it("emits no per-workflow entry when queues are unchanged", () => {
		const result = diffManifests({
			oldWorkflows: new Map([["wf", manifest("wf", ["jobs"])]]),
			newWorkflows: new Map([["wf", manifest("wf", ["jobs"])]]),
		});
		expect(result.perWorkflow).toEqual([]);
		expect(result.removedWorkflows).toEqual([]);
		expect(result.newWorkflows).toEqual([]);
	});
});

describe("applyQueueDiff", () => {
	let queuesRoot: string;
	beforeEach(async () => {
		queuesRoot = await makeTempRoot();
	});

	it("creates parent dirs and empty files for new workflows + queues", async () => {
		await applyQueueDiff({
			queuesRoot,
			owner: "acme",
			repo: "widgets",
			removedWorkflows: [],
			perWorkflow: [],
			newWorkflows: [{ workflow: "orders", queues: ["jobs", "emails"] }],
			logger: noopLogger,
		});
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		const files = await readdir(dir);
		expect(files.sort()).toEqual(["emails.ndjson", "jobs.ndjson"]);
		const jobs = await readFile(join(dir, "jobs.ndjson"), "utf8");
		expect(jobs).toBe("");
	});

	it("unlinks removed queues for an existing workflow", async () => {
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "old.ndjson"), '{"a":1}\n');
		await writeFile(join(dir, "kept.ndjson"), "");
		await applyQueueDiff({
			queuesRoot,
			owner: "acme",
			repo: "widgets",
			removedWorkflows: [],
			perWorkflow: [{ workflow: "orders", added: [], removed: ["old"] }],
			newWorkflows: [],
			logger: noopLogger,
		});
		const files = await readdir(dir);
		expect(files).toEqual(["kept.ndjson"]);
	});

	it("removes the entire workflow subtree when the workflow is removed", async () => {
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "jobs.ndjson"), "{}\n");
		await applyQueueDiff({
			queuesRoot,
			owner: "acme",
			repo: "widgets",
			removedWorkflows: ["orders"],
			perWorkflow: [],
			newWorkflows: [],
			logger: noopLogger,
		});
		const repoFiles = await readdir(join(queuesRoot, "acme", "widgets"));
		expect(repoFiles).toEqual([]);
	});

	it("is idempotent: re-applying the same add does not throw", async () => {
		const opts = {
			queuesRoot,
			owner: "acme",
			repo: "widgets",
			removedWorkflows: [],
			perWorkflow: [],
			newWorkflows: [{ workflow: "orders", queues: ["jobs"] }],
			logger: noopLogger,
		};
		await applyQueueDiff(opts);
		await applyQueueDiff(opts);
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		const files = await readdir(dir);
		expect(files).toEqual(["jobs.ndjson"]);
	});

	it("is idempotent: re-applying a remove tolerates ENOENT", async () => {
		await applyQueueDiff({
			queuesRoot,
			owner: "acme",
			repo: "widgets",
			removedWorkflows: ["never-existed"],
			perWorkflow: [
				{ workflow: "also-not-there", added: [], removed: ["ghost"] },
			],
			newWorkflows: [],
			logger: noopLogger,
		});
		// No throw == pass.
	});
});

describe("reconcileQueueFiles", () => {
	let queuesRoot: string;
	beforeEach(async () => {
		queuesRoot = await makeTempRoot();
	});

	it("tolerates a missing root directory", async () => {
		await reconcileQueueFiles({
			queuesRoot: join(queuesRoot, "nonexistent"),
			loadedWorkflows: new Map(),
			logger: noopLogger,
		});
		// No throw == pass.
	});

	it("creates missing files for declared queues (SIGKILL between manifest persist and create)", async () => {
		// Simulate: manifest declares queue but file is missing.
		const loaded = new Map([
			[
				"acme",
				new Map([
					["widgets", new Map([["orders", manifest("orders", ["jobs"])]])],
				]),
			],
		]);
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: loaded,
			logger: noopLogger,
		});
		const file = join(queuesRoot, "acme", "widgets", "orders", "jobs.ndjson");
		const content = await readFile(file, "utf8");
		expect(content).toBe("");
	});

	it("unlinks orphan files belonging to a removed queue declaration", async () => {
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "old.ndjson"), "{}\n");
		await writeFile(join(dir, "jobs.ndjson"), "");
		const loaded = new Map([
			[
				"acme",
				new Map([
					["widgets", new Map([["orders", manifest("orders", ["jobs"])]])],
				]),
			],
		]);
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: loaded,
			logger: noopLogger,
		});
		const files = await readdir(dir);
		expect(files).toEqual(["jobs.ndjson"]);
	});

	it("removes the workflow subtree for unloaded workflows", async () => {
		const dir = join(queuesRoot, "acme", "widgets", "ghost");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "jobs.ndjson"), "{}\n");
		// loaded contains the repo but not the ghost workflow.
		const loaded = new Map([
			["acme", new Map([["widgets", new Map<string, WorkflowManifest>()]])],
		]);
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: loaded,
			logger: noopLogger,
		});
		const repoFiles = await readdir(join(queuesRoot, "acme", "widgets"));
		expect(repoFiles).toEqual([]);
	});

	it("removes orphan owner subtrees not in the loaded set", async () => {
		const dir = join(queuesRoot, "ghostowner", "x", "y");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "jobs.ndjson"), "");
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: new Map(),
			logger: noopLogger,
		});
		const owners = await readdir(queuesRoot);
		expect(owners).toEqual([]);
	});

	it("preserves declared queues' content (does not truncate)", async () => {
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "jobs.ndjson"), '{"item":1}\n');
		const loaded = new Map([
			[
				"acme",
				new Map([
					["widgets", new Map([["orders", manifest("orders", ["jobs"])]])],
				]),
			],
		]);
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: loaded,
			logger: noopLogger,
		});
		const content = await readFile(join(dir, "jobs.ndjson"), "utf8");
		expect(content).toBe('{"item":1}\n');
	});

	it("removes stray non-ndjson files (e.g., orphaned tmpfiles)", async () => {
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "jobs.ndjson"), "");
		await writeFile(join(dir, "jobs.ndjson.tmp.deadbeef"), "garbage");
		const loaded = new Map([
			[
				"acme",
				new Map([
					["widgets", new Map([["orders", manifest("orders", ["jobs"])]])],
				]),
			],
		]);
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: loaded,
			logger: noopLogger,
		});
		const files = await readdir(dir);
		expect(files).toEqual(["jobs.ndjson"]);
	});
});
