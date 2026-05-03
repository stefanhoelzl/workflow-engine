// Crash-recovery tests for the registry's queue file lifecycle.
//
// The upload tx applies the queue diff (mkdir + touch + fsync(parentDir) for
// added queues, unlink + fsync(parentDir) for removed queues) atomically
// with the in-memory metadata swap. SIGKILL between any of those steps
// leaves the on-disk state in some intermediate form; the next boot's
// `reconcileQueueFiles` sweep is responsible for converging back to the
// "file exists ⇔ queue declared" invariant.
//
// These tests fork a child that performs a partial upload-tx fs op,
// SIGKILL it at controlled checkpoints, then run `reconcileQueueFiles`
// in the parent against the loaded-workflow snapshot. The post-sweep
// state must satisfy the invariant.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowManifest } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import type { Logger } from "./logger.js";
import { reconcileQueueFiles } from "./queue-fs-lifecycle.js";

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
		queues: queueNames.map((q) => ({ name: q, schema: { type: "object" } })),
	};
}

interface RunCrashOptions {
	readonly scriptPath: string;
	readonly args: readonly string[];
	readonly stageBeforeKill: string;
}

async function runCrashChild(opts: RunCrashOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[opts.scriptPath, ...opts.args, opts.stageBeforeKill],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdoutBuffer = "";
		let killed = false;
		const timer = setTimeout(() => {
			if (!killed) {
				child.kill("SIGKILL");
				reject(new Error("crash test timed out"));
			}
		}, 10_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			if (
				!killed &&
				stdoutBuffer.includes(`${opts.stageBeforeKill}\n`) &&
				stdoutBuffer.includes("READY\n")
			) {
				killed = true;
				child.kill("SIGKILL");
			}
		});
		child.on("close", () => {
			clearTimeout(timer);
			setTimeout(resolve, 50);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

// Child script that simulates an upload-tx ADDING a queue, but staged: pause
// after creating the workflow dir but before touching the file. SIGKILL at
// that point leaves the dir without the file — the boot sweep must restore
// the missing file.
const ADD_QUEUE_CRASH_SCRIPT = `
import { mkdir, open as fsOpen } from "node:fs/promises";
import { constants as C } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";

const [queuesRoot, owner, repo, workflow, queueName, stage] = process.argv.slice(2);
async function main() {
	const dir = join(queuesRoot, owner, repo, workflow);
	await mkdir(dir, { recursive: true });
	if (stage === "after-mkdir-before-touch") {
		console.log("after-mkdir-before-touch"); console.log("READY"); await new Promise(()=>{});
	}
	const handle = await fsOpen(join(dir, queueName + ".ndjson"), C.O_WRONLY | C.O_CREAT, 0o600);
	await handle.close();
	console.log("done"); exit(0);
}
main().catch(err => { console.error(err); exit(1); });
`;

// Child script that simulates an upload-tx REMOVING a queue, but staged:
// pause before the unlink so SIGKILL leaves the file in place. Boot sweep
// must unlink it.
const REMOVE_QUEUE_CRASH_SCRIPT = `
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { exit } from "node:process";

const [queuesRoot, owner, repo, workflow, queueName, stage] = process.argv.slice(2);
async function main() {
	if (stage === "before-unlink") {
		console.log("before-unlink"); console.log("READY"); await new Promise(()=>{});
	}
	await unlink(join(queuesRoot, owner, repo, workflow, queueName + ".ndjson"));
	console.log("done"); exit(0);
}
main().catch(err => { console.error(err); exit(1); });
`;

async function makeChildScript(
	dir: string,
	name: string,
	content: string,
): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, content, "utf8");
	return path;
}

describe("queue lifecycle crash recovery — boot sweep restores invariant", () => {
	it("SIGKILL between mkdir and touch on add: boot sweep creates the missing file", async () => {
		const root = await mkdtemp(join(tmpdir(), "wfe-life-crash-"));
		const queuesRoot = join(root, "queues");
		const script = await makeChildScript(
			root,
			"child.mjs",
			ADD_QUEUE_CRASH_SCRIPT,
		);
		await runCrashChild({
			scriptPath: script,
			args: [queuesRoot, "acme", "widgets", "orders", "jobs"],
			stageBeforeKill: "after-mkdir-before-touch",
		});
		// Child died after `mkdir -p` but before the touch — dir exists, file does not.
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		const filesBefore = await readdir(dir);
		expect(filesBefore).toEqual([]);
		// Boot sweep simulates the registry's `runBootQueueReconcile` running
		// against the loaded-workflows snapshot.
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: new Map([
				[
					"acme",
					new Map([
						["widgets", new Map([["orders", manifest("orders", ["jobs"])]])],
					]),
				],
			]),
			logger: noopLogger,
		});
		// Sweep restored the missing file as zero-byte.
		const filesAfter = await readdir(dir);
		expect(filesAfter).toEqual(["jobs.ndjson"]);
		expect(await readFile(join(dir, "jobs.ndjson"), "utf8")).toBe("");
	});

	it("SIGKILL before unlink on remove: boot sweep unlinks the orphan", async () => {
		const root = await mkdtemp(join(tmpdir(), "wfe-life-crash-"));
		const queuesRoot = join(root, "queues");
		const dir = join(queuesRoot, "acme", "widgets", "orders");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "jobs.ndjson"), "");
		await writeFile(join(dir, "old.ndjson"), '{"item":1}\n');
		const script = await makeChildScript(
			root,
			"child.mjs",
			REMOVE_QUEUE_CRASH_SCRIPT,
		);
		await runCrashChild({
			scriptPath: script,
			args: [queuesRoot, "acme", "widgets", "orders", "old"],
			stageBeforeKill: "before-unlink",
		});
		// Child died before the unlink — the orphan file is still there.
		const filesBefore = await readdir(dir);
		expect(filesBefore.sort()).toEqual(["jobs.ndjson", "old.ndjson"]);
		// Manifest declares only `jobs`; `old` is no longer declared.
		await reconcileQueueFiles({
			queuesRoot,
			loadedWorkflows: new Map([
				[
					"acme",
					new Map([
						["widgets", new Map([["orders", manifest("orders", ["jobs"])]])],
					]),
				],
			]),
			logger: noopLogger,
		});
		// Sweep removed the orphan, kept the legitimate file.
		const filesAfter = await readdir(dir);
		expect(filesAfter).toEqual(["jobs.ndjson"]);
	});
});
