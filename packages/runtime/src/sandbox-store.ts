import { type WorkflowManifest, z } from "@workflow-engine/core";
import type {
	HostHandlers,
	PluginDescriptor,
	Sandbox,
	SandboxFactory,
} from "@workflow-engine/sandbox";
// The `?sandbox-plugin` query is intercepted by the `sandboxPlugins()` vite
// transform, which esbuild-bundles the target file's `worker` export into a
// self-contained ESM string (loaded by the worker via `data:` URI). That
// pipeline requires TS source — going through each package's `exports` field
// would resolve to a tsc-built `.js` and lose source-level tree-shaking.
// Hence the raw `../../<pkg>/src/*.ts?sandbox-plugin` shape. The `.ts`
// extension is consumed by vite before emit, so the usual `.js`-extension
// rule (for `verbatimModuleSyntax`) does not apply at these call sites.
import wasiPlugin from "../../sandbox/src/plugins/wasi-plugin.ts?sandbox-plugin";
import consolePlugin from "../../sandbox-stdlib/src/console/index.ts?sandbox-plugin";
import fetchPlugin from "../../sandbox-stdlib/src/fetch/index.ts?sandbox-plugin";
import mailPlugin from "../../sandbox-stdlib/src/mail/index.ts?sandbox-plugin";
import queuePlugin from "../../sandbox-stdlib/src/queue/index.ts?sandbox-plugin";
import sqlPlugin from "../../sandbox-stdlib/src/sql/index.ts?sandbox-plugin";
import timersPlugin from "../../sandbox-stdlib/src/timers/index.ts?sandbox-plugin";
import webPlatformPlugin from "../../sandbox-stdlib/src/web-platform/index.ts?sandbox-plugin";
import { compileActionValidators } from "./host-call-action-config.js";
import type { Logger } from "./logger.js";
import actionDispatchPlugin from "./plugins/action-dispatch.ts?sandbox-plugin";
import hostCallActionPlugin from "./plugins/host-call-action.ts?sandbox-plugin";
import secretsPlugin from "./plugins/secrets.ts?sandbox-plugin";
import triggerPlugin from "./plugins/trigger.ts?sandbox-plugin";
import wasiTelemetryPlugin from "./plugins/wasi-telemetry.ts?sandbox-plugin";
import { buildQueueHostHandlers } from "./queue-host.js";
import type { QueueStore } from "./queue-store.js";
import { decryptWorkflowSecrets } from "./secrets/decrypt-workflow.js";
import type { SecretsKeyStore } from "./secrets/index.js";

// Per-(owner, sha) sandbox cache bounded by `maxCount` entries (soft cap).
// LRU eviction is driven exclusively by creation-miss pressure: on hit the
// entry is promoted to MRU; on miss a fresh entry is inserted at MRU and a
// sweep tries to trim the cache from the LRU end, skipping entries whose
// promise has not yet resolved and entries whose resolved sandbox is mid-run
// (`sandbox.isActive === true`). If every candidate is busy or building the
// cache is allowed to exceed `maxCount` temporarily — the next sweep
// reclaims once something becomes evictable.

interface SandboxStore {
	get(
		owner: string,
		workflow: WorkflowManifest,
		bundleSource: string,
	): Promise<Sandbox>;
	dispose(): Promise<void>;
}

interface SandboxStoreOptions {
	readonly sandboxFactory: SandboxFactory;
	readonly logger: Logger;
	readonly keyStore: SecretsKeyStore;
	readonly maxCount: number;
	// Host-side singleton consumed by per-sandbox queue host handlers.
	// queueStore owns the libSQL-backed FIFO storage. (No registry dependency:
	// the queue handlers apply no name gate, so they never consult the live
	// manifest — there is no construction cycle to break.)
	readonly queueStore: QueueStore;
}

interface CacheEntry {
	readonly key: string;
	readonly owner: string;
	readonly sha: string;
	readonly createdAt: number;
	readonly promise: Promise<Sandbox>;
	// Populated when `promise` resolves; stays null for still-building entries
	// and also if the build rejected (in which case the entry is removed from
	// the cache anyway — see `build` below).
	sandbox: Sandbox | null;
	runCount: number;
}

const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 25;

function storeKey(owner: string, sha: string): string {
	return `${owner}/${sha}`;
}

function buildPluginDescriptors(
	workflow: WorkflowManifest,
	keyStore: SecretsKeyStore,
): readonly PluginDescriptor[] {
	// Per-plugin `Config` interfaces are structurally JSON-serializable but
	// TS can't prove they satisfy the index-signature constraint of
	// `SerializableConfig`. `serializePluginDescriptors` asserts the shape
	// at construction time; a widening cast through `unknown` is required.
	const hostCallActionConfig = compileActionValidators(
		workflow,
	) as unknown as PluginDescriptor["config"];
	// Decrypt manifest.secrets once per sandbox — plaintexts live for the
	// sandbox's lifetime (which is scoped to (owner, workflow.sha), so
	// the ciphertexts on the manifest would be stable anyway).
	const plaintextStore = decryptWorkflowSecrets(workflow, keyStore);
	const secretsConfig = {
		name: workflow.name,
		env: workflow.env,
		plaintextStore,
	} as unknown as PluginDescriptor["config"];
	// The queue plugin is config-less transport: all per-workflow knowledge
	// (declared set, validators) lives host-side in the queue host handlers
	// (see buildQueueHostHandlersFor). The worker needs nothing at construction.
	return [
		{ ...wasiPlugin },
		{ ...wasiTelemetryPlugin },
		{ ...secretsPlugin, config: secretsConfig },
		{ ...webPlatformPlugin },
		{ ...fetchPlugin },
		{ ...mailPlugin },
		{ ...sqlPlugin },
		{ ...queuePlugin },
		{ ...timersPlugin },
		{ ...consolePlugin },
		{ ...hostCallActionPlugin, config: hostCallActionConfig },
		{ ...actionDispatchPlugin },
		{ ...triggerPlugin },
	];
}

function buildQueueHostHandlersFor(
	owner: string,
	workflow: WorkflowManifest,
	queueStore: QueueStore,
): HostHandlers {
	// Rehydrate per-queue Zod validators from the JSON Schemas in the manifest.
	// One-time cost per sandbox construction; the resulting Map is held in the
	// handler closure for the sandbox's lifetime. The map's keys are the
	// declared queue names — a name absent from it is undeclared (accepted,
	// but stored/returned without schema validation).
	const validators = new Map<string, z.ZodType<unknown>>();
	for (const q of workflow.queues) {
		validators.set(
			q.name,
			z.fromJSONSchema(
				q.schema as Record<string, unknown>,
			) as z.ZodType<unknown>,
		);
	}
	return buildQueueHostHandlers({
		owner,
		workflow: workflow.name,
		validators,
		queueStore,
	});
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups cache LRU bookkeeping, eviction sweep, and dispose drain
function createSandboxStore(options: SandboxStoreOptions): SandboxStore {
	const { sandboxFactory, keyStore, logger, maxCount, queueStore } = options;
	const cache = new Map<string, CacheEntry>();
	const pendingDisposals = new Set<Promise<void>>();

	function build(
		owner: string,
		workflow: WorkflowManifest,
		bundleSource: string,
	): Promise<Sandbox> {
		return sandboxFactory.create({
			source: bundleSource,
			filename: `${workflow.name}.js`,
			plugins: buildPluginDescriptors(workflow, keyStore),
			hostHandlers: buildQueueHostHandlersFor(owner, workflow, queueStore),
		});
	}

	function disposeEntry(
		entry: CacheEntry,
		reason: "lru" | "store-dispose",
	): void {
		const sb = entry.sandbox;
		if (!sb) {
			return;
		}
		const p = sb
			.dispose()
			.catch((err: unknown) => {
				logger.error("sandbox dispose failed", {
					owner: entry.owner,
					sha: entry.sha,
					reason,
					err,
				});
			})
			.finally(() => {
				pendingDisposals.delete(p);
			});
		pendingDisposals.add(p);
	}

	function sweep(): void {
		if (cache.size <= maxCount) {
			return;
		}
		// Map iteration is insertion-ordered: oldest first. Collect victims
		// first to avoid deleting during iteration (safe in JS Maps, but
		// collecting keeps the intent explicit).
		const victims: CacheEntry[] = [];
		let remaining = cache.size;
		for (const entry of cache.values()) {
			if (remaining <= maxCount) {
				break;
			}
			if (entry.sandbox === null) {
				// Still building — skip.
				continue;
			}
			if (entry.sandbox.isActive) {
				// Mid-run — skip; next sweep may reclaim.
				continue;
			}
			victims.push(entry);
			remaining--;
		}
		for (const victim of victims) {
			cache.delete(victim.key);
			const ageMs = Date.now() - victim.createdAt;
			logger.info("sandbox evicted", {
				owner: victim.owner,
				sha: victim.sha,
				reason: "lru",
				ageMs,
				runCount: victim.runCount,
			});
			disposeEntry(victim, "lru");
		}
	}

	return {
		get(owner, workflow, bundleSource) {
			const key = storeKey(owner, workflow.sha);
			const existing = cache.get(key);
			if (existing) {
				// Move to MRU (re-insertion at the tail of the insertion order).
				cache.delete(key);
				cache.set(key, existing);
				existing.runCount++;
				return existing.promise;
			}
			const promise = build(owner, workflow, bundleSource);
			const entry: CacheEntry = {
				key,
				owner,
				sha: workflow.sha,
				createdAt: Date.now(),
				promise,
				sandbox: null,
				runCount: 1,
			};
			cache.set(key, entry);
			promise
				.then((sb) => {
					entry.sandbox = sb;
					// Any worker termination (limit breach or crash) evicts the
					// cached entry so the next `get()` rebuilds cold. See
					// `openspec/specs/sandbox/spec.md` "Eviction on sandbox
					// termination".
					sb.onTerminated((cause) => {
						if (cache.get(key) === entry) {
							cache.delete(key);
						}
						logger.info("sandbox evicted", {
							owner,
							sha: workflow.sha,
							reason: cause.kind === "limit" ? "limit" : "crash",
							...(cause.kind === "limit" ? { dimension: cause.dim } : {}),
						});
					});
				})
				.catch(() => {
					// Build failed — remove the entry so the next get() retries.
					// (Only remove if the map still points to this entry; a
					// later re-upload may have replaced it.)
					if (cache.get(key) === entry) {
						cache.delete(key);
					}
				});
			sweep();
			return promise;
		},
		async dispose() {
			// Drain: poll until every cached sandbox reports !isActive (or
			// hits the deadline). The shutdown handler in main.ts emits
			// `shutdown.complete` only after this resolves, giving in-flight
			// invocations a chance to land their terminal events through the
			// bus before the sandbox is destroyed (see openspec
			// service-lifecycle spec).
			const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
			while (Date.now() < drainDeadline) {
				let anyActive = false;
				for (const entry of cache.values()) {
					if (entry.sandbox?.isActive === true) {
						anyActive = true;
						break;
					}
				}
				if (!anyActive) {
					break;
				}
				// biome-ignore lint/performance/noAwaitInLoops: drain poll is intentionally sequential — each iteration must observe the result of the previous wait
				await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
			}
			const entries = [...cache.values()];
			cache.clear();
			// Wait for in-flight builds to settle so `entry.sandbox` is
			// populated (or known-failed) before we attempt disposal. Build
			// rejections are already self-removed from the cache, but the
			// snapshot captured them; swallow here so we still proceed to
			// dispose the rest.
			const drains = entries.map((entry) =>
				entry.promise.then(
					() => {
						disposeEntry(entry, "store-dispose");
					},
					() => {
						/* build failed; nothing to dispose for this entry */
					},
				),
			);
			await Promise.all(drains);
			// `disposeEntry` populates `pendingDisposals` synchronously when
			// invoked above (entry.sandbox is non-null), and each of those
			// promises is `.catch`-protected internally, so allSettled is not
			// strictly required — Promise.all here cannot reject.
			await Promise.all([...pendingDisposals]);
		},
	};
}

export type { SandboxStore, SandboxStoreOptions };
export { buildPluginDescriptors, createSandboxStore };
