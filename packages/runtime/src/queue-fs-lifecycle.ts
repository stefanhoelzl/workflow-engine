// Filesystem lifecycle for queue files, owned by the workflow registry.
//
// Two surfaces:
//   • `applyQueueDiff` — runs in the upload transaction. Diffs old vs new
//     manifests for one (owner, repo) and performs the corresponding fs ops:
//     create empty file (with mkdir -p + fsync(parentDir)) for added queues,
//     `unlink` for removed queues. Removed workflows have their entire queue
//     subtree removed.
//   • `reconcileQueueFiles` — runs once after `registry.recover()` at boot.
//     For every loaded workflow it ensures (a) every declared queue has a
//     file (touch missing) and (b) no extraneous `*.ndjson` files exist
//     under the workflow's queue dir (unlink orphans). Tolerates a missing
//     `<root>/queues/` root.
//
// All ops are idempotent — they tolerate ENOENT on unlink and EEXIST on
// create — so SIGKILL between manifest persist and the fs op can be
// reconciled by either a fresh boot sweep or a repeated upload.
//
// Per-workflow ops within one (owner, repo) upload run in parallel
// (`Promise.all`) because each workflow's queue dir is independent of every
// other workflow's dir under the same repo. Per-queue ops within one
// workflow run sequentially because they share a parent directory whose
// final fsync needs to come after all unlinks/creates have settled.

import { constants as fsConstants } from "node:fs";
import { open as fsOpen, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowManifest } from "@workflow-engine/core";
import type { Logger } from "./logger.js";

// rwx for owner only on the touched empty file; matches the worker's tmpfile
// posture so the file is always owned-and-readable by the runtime user.
const QUEUE_FILE_MODE_OWNER_RW = 0o600;

interface QueueWorkflowDiff {
	readonly workflow: string;
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

interface QueueWorkflowAdd {
	readonly workflow: string;
	readonly queues: readonly string[];
}

interface ApplyQueueDiffOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly removedWorkflows: readonly string[];
	readonly perWorkflow: readonly QueueWorkflowDiff[];
	readonly newWorkflows: readonly QueueWorkflowAdd[];
	readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// Low-level fs helpers
// ---------------------------------------------------------------------------

async function fsyncDir(dirPath: string): Promise<void> {
	const handle = await fsOpen(dirPath, fsConstants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function openCreateFlags(): number {
	// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose via bitwise OR
	return fsConstants.O_WRONLY | fsConstants.O_CREAT;
}

async function touchEmpty(path: string): Promise<void> {
	// O_CREAT without O_EXCL: tolerate an existing file (e.g. a re-upload of
	// the same manifest hits this path again).
	const handle = await fsOpen(
		path,
		openCreateFlags(),
		QUEUE_FILE_MODE_OWNER_RW,
	);
	await handle.close();
}

async function unlinkIfExists(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			return false;
		}
		throw err;
	}
}

async function fsyncDirTolerant(dirPath: string): Promise<void> {
	try {
		await fsyncDir(dirPath);
	} catch (err) {
		if ((err as { code?: string }).code !== "ENOENT") {
			throw err;
		}
		// Directory was removed (all queues unlinked, dir gc'd). Nothing to fsync.
	}
}

// ---------------------------------------------------------------------------
// Per-workflow apply helpers
// ---------------------------------------------------------------------------

interface ApplyDiffPerWorkflowOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly diff: QueueWorkflowDiff;
	readonly logger: Logger;
}

async function applyDiffForWorkflow(
	opts: ApplyDiffPerWorkflowOptions,
): Promise<void> {
	const { queuesRoot, owner, repo, diff, logger } = opts;
	const dir = join(queuesRoot, owner, repo, diff.workflow);
	// Unlinks first, then creates. fsync the dir once after both batches so
	// crash-recovery sees them as one transaction.
	const unlinkResults = await Promise.all(
		diff.removed.map(async (queue) => {
			const path = join(dir, `${queue}.ndjson`);
			const removed = await unlinkIfExists(path);
			if (removed) {
				logger.info("queue-lifecycle.queue-removed", {
					owner,
					repo,
					workflow: diff.workflow,
					queue,
				});
			}
			return removed;
		}),
	);
	if (diff.added.length > 0) {
		await mkdir(dir, { recursive: true });
		await Promise.all(
			diff.added.map(async (queue) => {
				await touchEmpty(join(dir, `${queue}.ndjson`));
				logger.info("queue-lifecycle.queue-added", {
					owner,
					repo,
					workflow: diff.workflow,
					queue,
				});
			}),
		);
	}
	if (unlinkResults.length > 0 || diff.added.length > 0) {
		await fsyncDirTolerant(dir);
	}
}

interface ApplyNewWorkflowOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly add: QueueWorkflowAdd;
	readonly logger: Logger;
}

async function applyNewWorkflow(opts: ApplyNewWorkflowOptions): Promise<void> {
	if (opts.add.queues.length === 0) {
		return;
	}
	const dir = join(opts.queuesRoot, opts.owner, opts.repo, opts.add.workflow);
	await mkdir(dir, { recursive: true });
	await Promise.all(
		opts.add.queues.map(async (queue) => {
			await touchEmpty(join(dir, `${queue}.ndjson`));
			opts.logger.info("queue-lifecycle.queue-added", {
				owner: opts.owner,
				repo: opts.repo,
				workflow: opts.add.workflow,
				queue,
			});
		}),
	);
	await fsyncDir(dir);
}

interface DropWorkflowOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly logger: Logger;
}

async function dropWorkflow(opts: DropWorkflowOptions): Promise<void> {
	const dir = join(opts.queuesRoot, opts.owner, opts.repo, opts.workflow);
	await rm(dir, { recursive: true, force: true });
	opts.logger.info("queue-lifecycle.workflow-dropped", {
		owner: opts.owner,
		repo: opts.repo,
		workflow: opts.workflow,
	});
}

async function applyQueueDiff(opts: ApplyQueueDiffOptions): Promise<void> {
	const { queuesRoot, owner, repo, logger } = opts;
	await Promise.all(
		opts.removedWorkflows.map((workflow) =>
			dropWorkflow({ queuesRoot, owner, repo, workflow, logger }),
		),
	);
	await Promise.all(
		opts.perWorkflow.map((diff) =>
			applyDiffForWorkflow({ queuesRoot, owner, repo, diff, logger }),
		),
	);
	await Promise.all(
		opts.newWorkflows.map((add) =>
			applyNewWorkflow({ queuesRoot, owner, repo, add, logger }),
		),
	);
}

// ---------------------------------------------------------------------------
// Diff helpers (pure)
// ---------------------------------------------------------------------------

interface ManifestPair {
	readonly oldWorkflows: ReadonlyMap<string, WorkflowManifest>;
	readonly newWorkflows: ReadonlyMap<string, WorkflowManifest>;
}

interface DiffResult {
	readonly removedWorkflows: string[];
	readonly perWorkflow: QueueWorkflowDiff[];
	readonly newWorkflows: QueueWorkflowAdd[];
}

function computePerWorkflowDiff(
	oldWf: WorkflowManifest,
	newWf: WorkflowManifest,
): QueueWorkflowDiff | null {
	const oldNames = new Set(oldWf.queues.map((q) => q.name));
	const newNames = new Set(newWf.queues.map((q) => q.name));
	const added: string[] = [];
	const removed: string[] = [];
	for (const n of newNames) {
		if (!oldNames.has(n)) {
			added.push(n);
		}
	}
	for (const n of oldNames) {
		if (!newNames.has(n)) {
			removed.push(n);
		}
	}
	if (added.length === 0 && removed.length === 0) {
		return null;
	}
	return { workflow: newWf.name, added, removed };
}

function diffManifests(pair: ManifestPair): DiffResult {
	const removedWorkflows: string[] = [];
	const perWorkflow: QueueWorkflowDiff[] = [];
	const newWorkflows: QueueWorkflowAdd[] = [];
	for (const [name, oldWf] of pair.oldWorkflows) {
		const newWf = pair.newWorkflows.get(name);
		if (newWf === undefined) {
			removedWorkflows.push(name);
			continue;
		}
		const wfDiff = computePerWorkflowDiff(oldWf, newWf);
		if (wfDiff !== null) {
			perWorkflow.push(wfDiff);
		}
	}
	for (const [name, newWf] of pair.newWorkflows) {
		if (!pair.oldWorkflows.has(name)) {
			newWorkflows.push({
				workflow: name,
				queues: newWf.queues.map((q) => q.name),
			});
		}
	}
	return { removedWorkflows, perWorkflow, newWorkflows };
}

// ---------------------------------------------------------------------------
// Boot reconciliation sweep
// ---------------------------------------------------------------------------

interface ReconcileOptions {
	readonly queuesRoot: string;
	readonly loadedWorkflows: ReadonlyMap<
		string,
		ReadonlyMap<string, ReadonlyMap<string, WorkflowManifest>>
	>;
	readonly logger: Logger;
}

async function listDirSafe(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			return [];
		}
		throw err;
	}
}

interface SweepRepoOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflows: ReadonlyMap<string, WorkflowManifest>;
	readonly logger: Logger;
}

interface SweepWorkflowOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflowName: string;
	readonly manifest: WorkflowManifest | undefined;
	readonly logger: Logger;
}

async function sweepWorkflowDir(opts: SweepWorkflowOptions): Promise<void> {
	const { queuesRoot, owner, repo, workflowName, manifest, logger } = opts;
	const workflowDir = join(queuesRoot, owner, repo, workflowName);
	if (manifest === undefined) {
		await rm(workflowDir, { recursive: true, force: true });
		logger.info("queue-lifecycle.boot-sweep-workflow-removed", {
			owner,
			repo,
			workflow: workflowName,
		});
		return;
	}
	const declared = new Set(manifest.queues.map((q) => q.name));
	const filesOnDisk = await listDirSafe(workflowDir);
	await Promise.all(
		filesOnDisk.map(async (fname) => {
			if (!fname.endsWith(".ndjson")) {
				await unlinkIfExists(join(workflowDir, fname));
				logger.info("queue-lifecycle.boot-sweep-stray-removed", {
					owner,
					repo,
					workflow: workflowName,
					name: fname,
				});
				return;
			}
			const queueName = fname.slice(0, -".ndjson".length);
			if (!declared.has(queueName)) {
				await unlinkIfExists(join(workflowDir, fname));
				logger.info("queue-lifecycle.boot-sweep-orphan-removed", {
					owner,
					repo,
					workflow: workflowName,
					queue: queueName,
				});
			}
		}),
	);
}

async function sweepRepo(opts: SweepRepoOptions): Promise<void> {
	const repoDir = join(opts.queuesRoot, opts.owner, opts.repo);
	const workflowDirs = await listDirSafe(repoDir);
	await Promise.all(
		workflowDirs.map((workflowName) =>
			sweepWorkflowDir({
				queuesRoot: opts.queuesRoot,
				owner: opts.owner,
				repo: opts.repo,
				workflowName,
				manifest: opts.workflows.get(workflowName),
				logger: opts.logger,
			}),
		),
	);
}

interface RestoreWorkflowOptions {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflowName: string;
	readonly manifest: WorkflowManifest;
	readonly logger: Logger;
}

async function restoreMissingFiles(
	opts: RestoreWorkflowOptions,
): Promise<void> {
	if (opts.manifest.queues.length === 0) {
		return;
	}
	const dir = join(opts.queuesRoot, opts.owner, opts.repo, opts.workflowName);
	await mkdir(dir, { recursive: true });
	try {
		await Promise.all(
			opts.manifest.queues.map((q) =>
				touchEmpty(join(dir, `${q.name}.ndjson`)),
			),
		);
	} catch (err) {
		opts.logger.error("queue-lifecycle.boot-sweep-create-failed", {
			owner: opts.owner,
			repo: opts.repo,
			workflow: opts.workflowName,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
	await fsyncDir(dir);
}

async function removeUnknownOwners(
	queuesRoot: string,
	loadedOwners: ReadonlySet<string>,
	logger: Logger,
): Promise<readonly string[]> {
	const ownersOnDisk = await listDirSafe(queuesRoot);
	const known: string[] = [];
	await Promise.all(
		ownersOnDisk.map(async (owner) => {
			if (loadedOwners.has(owner)) {
				known.push(owner);
				return;
			}
			await rm(join(queuesRoot, owner), { recursive: true, force: true });
			logger.info("queue-lifecycle.boot-sweep-owner-removed", { owner });
		}),
	);
	return known;
}

async function removeUnknownRepos(
	queuesRoot: string,
	owner: string,
	loadedRepos: ReadonlyMap<string, ReadonlyMap<string, WorkflowManifest>>,
	logger: Logger,
): Promise<readonly string[]> {
	const ownerDir = join(queuesRoot, owner);
	const reposOnDisk = await listDirSafe(ownerDir);
	const known: string[] = [];
	await Promise.all(
		reposOnDisk.map(async (repo) => {
			if (loadedRepos.has(repo)) {
				known.push(repo);
				return;
			}
			await rm(join(ownerDir, repo), { recursive: true, force: true });
			logger.info("queue-lifecycle.boot-sweep-repo-removed", { owner, repo });
		}),
	);
	return known;
}

async function sweepOwner(
	queuesRoot: string,
	owner: string,
	ownerRepos: ReadonlyMap<string, ReadonlyMap<string, WorkflowManifest>>,
	logger: Logger,
): Promise<void> {
	const knownRepos = await removeUnknownRepos(
		queuesRoot,
		owner,
		ownerRepos,
		logger,
	);
	await Promise.all(
		knownRepos.map((repo) =>
			sweepRepo({
				queuesRoot,
				owner,
				repo,
				workflows: ownerRepos.get(repo) ?? new Map(),
				logger,
			}),
		),
	);
}

async function reconcileQueueFiles(opts: ReconcileOptions): Promise<void> {
	const { queuesRoot, loadedWorkflows, logger } = opts;
	const loadedOwners = new Set(loadedWorkflows.keys());
	const knownOwners = await removeUnknownOwners(
		queuesRoot,
		loadedOwners,
		logger,
	);
	await Promise.all(
		knownOwners.map((owner) =>
			sweepOwner(
				queuesRoot,
				owner,
				loadedWorkflows.get(owner) ?? new Map(),
				logger,
			),
		),
	);
	// Restore missing files for declared queues across the entire loaded set.
	const restoreTasks: Promise<void>[] = [];
	for (const [owner, repos] of loadedWorkflows) {
		for (const [repo, workflows] of repos) {
			for (const [workflowName, manifest] of workflows) {
				restoreTasks.push(
					restoreMissingFiles({
						queuesRoot,
						owner,
						repo,
						workflowName,
						manifest,
						logger,
					}),
				);
			}
		}
	}
	await Promise.all(restoreTasks);
}

export type {
	ApplyQueueDiffOptions,
	ManifestPair,
	QueueWorkflowAdd,
	QueueWorkflowDiff,
	ReconcileOptions,
};
export { applyQueueDiff, diffManifests, reconcileQueueFiles };
