// Upload-time + boot-time lifecycle for the libSQL-backed queue_items table,
// owned by the workflow registry.
//
// Surfaces (post queues-on-libsql migration):
//   • diffManifests        — pure diff of old vs new manifests, returns the
//                            list of (workflow, queueName) tuples whose
//                            declaration was removed and the list of
//                            entirely-removed workflows. Identical shape to
//                            the previous fs-lifecycle module so the registry
//                            can call it the same way.
//   • applyQueueDiffViaStore — runs in the upload transaction. DELETEs rows
//                            for removed queue declarations (DELETE WHERE
//                            tenant tuple matches) and for entirely removed
//                            workflows (DELETE WHERE owner+repo+workflow
//                            matches, no queue column).
//   • reconcileQueueStoreOnBoot — runs once after registry.recover(). Calls
//                            queueStore.reconcile with the FLATTENED list of
//                            (owner, repo, workflow, queue) tuples present
//                            in every loaded manifest; the store deletes
//                            every row whose tuple is not in that set.
//
// Notes vs the pre-migration filesystem module:
//   - Adding a queue declaration is now a NO-OP at lifecycle time. The
//     manifest IS the declaration; queue_items needs no marker row. The
//     first put inserts the first row.
//   - There is no "missing file" reconciliation; a declared queue with zero
//     rows is normal.
//   - All ops are tenant-scoped via queueStore's typed accessor — there is
//     no raw SQL access here.

import type { WorkflowManifest } from "@workflow-engine/core";
import type { Logger } from "./logger.js";
import type { QueueStore } from "./queue-store.js";

interface QueueWorkflowDiff {
	readonly workflow: string;
	readonly removed: readonly string[];
}

interface ManifestPair {
	readonly oldWorkflows: ReadonlyMap<string, WorkflowManifest>;
	readonly newWorkflows: ReadonlyMap<string, WorkflowManifest>;
}

interface DiffResult {
	readonly removedWorkflows: readonly string[];
	readonly perWorkflow: readonly QueueWorkflowDiff[];
}

// Compute the diff between two (owner, repo) manifest snapshots:
//   - removedWorkflows: workflows in `old` but not in `new`. Every row under
//     (owner, repo, workflow) will be DELETEd.
//   - perWorkflow: per-workflow lists of REMOVED queue names. Adds are not
//     tracked because they're no-ops at lifecycle time.
function diffManifests(pair: ManifestPair): DiffResult {
	const removedWorkflows: string[] = [];
	for (const [name] of pair.oldWorkflows) {
		if (!pair.newWorkflows.has(name)) {
			removedWorkflows.push(name);
		}
	}
	const perWorkflow: QueueWorkflowDiff[] = [];
	for (const [name, newWf] of pair.newWorkflows) {
		const oldWf = pair.oldWorkflows.get(name);
		if (!oldWf) {
			continue;
		}
		const oldQ = new Set(oldWf.queues.map((q) => q.name));
		const newQ = new Set(newWf.queues.map((q) => q.name));
		const removed: string[] = [];
		for (const qn of oldQ) {
			if (!newQ.has(qn)) {
				removed.push(qn);
			}
		}
		if (removed.length > 0) {
			perWorkflow.push({ workflow: name, removed });
		}
	}
	return { removedWorkflows, perWorkflow };
}

interface ApplyOptions {
	readonly queueStore: QueueStore;
	readonly owner: string;
	readonly repo: string;
	readonly diff: DiffResult;
	readonly logger: Logger;
}

// Apply the diff against the queue store. Errors propagate so the caller can
// fail the registration transaction (matches the pre-migration behavior).
//
// Each DELETE addresses a distinct (workflow) or (workflow, queue) tuple, so
// they are commutative and run concurrently via Promise.all. Logging is paired
// with the resolved row count.
async function applyQueueDiffViaStore(opts: ApplyOptions): Promise<void> {
	const { queueStore, owner, repo, diff, logger } = opts;

	const workflowOps = diff.removedWorkflows.map(async (workflow) => {
		const removed = await queueStore.removeDeclaration({
			owner,
			repo,
			workflow,
		});
		if (removed > 0) {
			logger.info("queue-store-lifecycle.workflow-removed", {
				owner,
				repo,
				workflow,
				rows: removed,
			});
		}
	});

	const queueOps = diff.perWorkflow.flatMap((wfDiff) =>
		wfDiff.removed.map(async (queue) => {
			const removed = await queueStore.removeDeclaration({
				owner,
				repo,
				workflow: wfDiff.workflow,
				queue,
			});
			if (removed > 0) {
				logger.info("queue-store-lifecycle.queue-removed", {
					owner,
					repo,
					workflow: wfDiff.workflow,
					queue,
					rows: removed,
				});
			}
		}),
	);

	await Promise.all([...workflowOps, ...queueOps]);
}

interface ReconcileOptions {
	readonly queueStore: QueueStore;
	// Map from owner → repo → workflow-name → WorkflowManifest. Mirrors the
	// shape exposed by the registry's snapshot helper.
	readonly loadedWorkflows: ReadonlyMap<
		string,
		ReadonlyMap<string, ReadonlyMap<string, WorkflowManifest>>
	>;
	readonly logger: Logger;
}

// One-shot at boot: build the flat tuple set from all loaded manifests and
// hand to queueStore.reconcile (which DELETEs everything else). Closes the
// SIGKILL-between-manifest-persist-and-DELETE window from the upload path.
async function reconcileQueueStoreOnBoot(
	opts: ReconcileOptions,
): Promise<void> {
	const tuples: {
		owner: string;
		repo: string;
		workflow: string;
		queue: string;
	}[] = [];
	for (const [owner, repos] of opts.loadedWorkflows) {
		for (const [repo, workflows] of repos) {
			for (const [workflowName, wf] of workflows) {
				for (const q of wf.queues) {
					tuples.push({
						owner,
						repo,
						workflow: workflowName,
						queue: q.name,
					});
				}
			}
		}
	}
	const removed = await opts.queueStore.reconcile(tuples);
	opts.logger.info("queue-store-lifecycle.boot-reconcile", {
		declaredTuples: tuples.length,
		removedRows: removed,
	});
}

export type {
	ApplyOptions,
	DiffResult,
	ManifestPair,
	QueueWorkflowDiff,
	ReconcileOptions,
};
export { applyQueueDiffViaStore, diffManifests, reconcileQueueStoreOnBoot };
