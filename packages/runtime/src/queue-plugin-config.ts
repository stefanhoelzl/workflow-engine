// Main-thread helper that builds the queue plugin's `Config` payload from a
// workflow manifest + the per-sandbox owner + the global queues root. The
// payload is JSON-serialisable across the postMessage boundary; the plugin's
// worker rehydrates Zod validators from the JSON Schemas at boot.

import type { WorkflowManifest } from "@workflow-engine/core";
import type { Config as QueuePluginConfig } from "../../sandbox-stdlib/src/queue/index.js";

interface BuildQueueConfigOptions {
	readonly owner: string;
	readonly workflow: WorkflowManifest;
	readonly queuesRoot: string;
}

/**
 * Compile the queue plugin's `Config` from a workflow manifest. Runs once
 * per sandbox construction (sandboxes are keyed by `(owner, workflow.sha)`);
 * the plugin's `worker()` rehydrates the JSON Schemas into Zod validators
 * once at boot and reuses them for the sandbox's lifetime.
 *
 * `repo` is NOT in the config — it varies per invocation (sandbox cache key
 * is `(owner, sha)`, not `(owner, repo, sha)`), so the runtime stamps it
 * via `RunInput.extras.queue.repo` at every `sb.run` site.
 */
function buildQueueConfig(opts: BuildQueueConfigOptions): QueuePluginConfig {
	const schemas: Record<string, Record<string, unknown>> = {};
	const declaredQueues: string[] = [];
	for (const q of opts.workflow.queues) {
		schemas[q.name] = q.schema as Record<string, unknown>;
		declaredQueues.push(q.name);
	}
	return {
		owner: opts.owner,
		workflow: opts.workflow.name,
		queuesRoot: opts.queuesRoot,
		declaredQueues,
		schemas,
	};
}

export type { BuildQueueConfigOptions };
export { buildQueueConfig };
