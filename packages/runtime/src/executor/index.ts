import type {
	DispatchMeta,
	InvocationEvent,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { Sandbox } from "@workflow-engine/sandbox";
import type { EventStore } from "../event-store.js";
import type { Logger } from "../logger.js";
import type { SandboxStore } from "../sandbox-store.js";
import {
	emitTriggerException,
	type TriggerExceptionParams,
} from "./exception.js";
import { logInvocationLifecycle } from "./log-lifecycle.js";
import { createRunQueue, type RunQueue } from "./run-queue.js";
import type { InvokeResult, TriggerDescriptor } from "./types.js";

interface InvocationMeta {
	readonly id: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly workflowSha: string;
	// Dispatch provenance. Forwarded from fire()'s optional `dispatch` arg;
	// defaults to `{ source: "trigger" }` when the caller omits it.
	readonly dispatch: DispatchMeta;
}

interface InvokeOptions {
	readonly bundleSource: string;
	readonly dispatch?: DispatchMeta;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
//
// The executor resolves the sandbox via the injected SandboxStore,
// serializes invocations per (owner, workflow.sha), wires the sandbox's
// onEvent stream to the bus, and calls sandbox.run. The sandbox emits
// trigger.request/response/error events itself — the executor does not
// construct lifecycle events.
//
// The executor is kind-agnostic: it returns a discriminated `InvokeResult`
// envelope. Each `TriggerSource` decides the protocol-level response on
// failure (HTTP 500 for the HTTP source; log-and-drop for cron; ...).

interface ExecutorOptions {
	readonly eventStore: EventStore;
	readonly logger: Logger;
	readonly sandboxStore: SandboxStore;
}

interface Executor {
	invoke(
		owner: string,
		repo: string,
		workflow: WorkflowManifest,
		descriptor: TriggerDescriptor,
		input: unknown,
		options: InvokeOptions,
	): Promise<InvokeResult<unknown>>;
	// Sibling to invoke for *author-fixable pre-dispatch failures* — emits
	// one `trigger.exception` leaf event onto the bus with no sandbox, no
	// run queue, no frame. Called only from `buildException` closures,
	// which are themselves called only via `entry.exception(...)` on a
	// TriggerEntry. SECURITY.md §2 R-8 host-side carve-out lives in the
	// `emitTriggerException` primitive imported above.
	fail(
		owner: string,
		repo: string,
		workflow: WorkflowManifest,
		descriptor: TriggerDescriptor,
		params: TriggerExceptionParams,
	): Promise<void>;
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

interface SandboxState {
	// One-time wire latch — the `sb.onEvent(...)` subscription is installed
	// on first invoke and reused for every subsequent run on this sandbox.
	wired: boolean;
	// Queue of pending `bus.emit` promises. The onEvent callback chains each
	// new emit onto this tail so emits stay sequential per sandbox;
	// `runInvocationWith` awaits the tail before returning to give callers a
	// "events committed before response" guarantee.
	emitTail: Promise<void>;
	// Current invocation metadata — set synchronously before `sb.run()`,
	// cleared after it resolves. The sandbox serves one run at a time
	// (enforced by `sb.run`'s concurrent-run reject), so every `SandboxEvent`
	// arriving on `sb.onEvent` between set and clear belongs to this
	// invocation. This is where runtime metadata is stamped — SECURITY.md
	// §2 R-8: the sandbox has no owner concept; the runtime widens events
	// from `SandboxEvent` to `InvocationEvent` at this boundary.
	activeMeta: InvocationMeta | null;
	// Per-sandbox serializer. `Sandbox.run()` rejects on concurrent calls,
	// so the executor serializes per sandbox instance. Two concurrent
	// invocations for the same `(owner, workflow.sha)` resolve to the same
	// sandbox via `sandboxStore.get()` (which caches by that key) and
	// therefore hit this same queue.
	runQueue: RunQueue;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups per-sandbox state, onEvent wiring, sequential emit tail, and invocation dispatch
function createExecutor(options: ExecutorOptions): Executor {
	const { eventStore, logger, sandboxStore } = options;
	// All per-sandbox executor state lives in a single WeakMap entry whose
	// lifetime equals the sandbox's. When `sandboxStore` evicts a sandbox
	// and the reference goes out of scope, GC reclaims the entry — no
	// string-keyed side-map, no cleanup hook.
	const sandboxState = new WeakMap<Sandbox, SandboxState>();

	function initState(sb: Sandbox): SandboxState {
		const state: SandboxState = {
			wired: false,
			emitTail: Promise.resolve(),
			activeMeta: null,
			runQueue: createRunQueue(),
		};
		sb.onEvent((event) => {
			const meta = state.activeMeta;
			if (!meta) {
				// Event arrived outside any invocation (should not happen — the
				// sandbox's buildEvent gates on runActive). Drop rather than record
				// unstamped event.
				return;
			}
			const widened: InvocationEvent = {
				...event,
				id: meta.id,
				owner: meta.owner,
				repo: meta.repo,
				workflow: meta.workflow,
				workflowSha: meta.workflowSha,
				// Dispatch provenance is stamped only onto the single
				// `trigger.request` event of each invocation (see
				// openspec/specs/invocations/spec.md). Other kinds join back
				// via the shared invocation `id`.
				...(event.kind === "trigger.request"
					? { meta: { dispatch: meta.dispatch } }
					: {}),
			};
			// EventStore.record() owns its own retry-then-drop policy and never
			// throws on transient backend failure (see event-store/spec.md). It
			// only rejects on a programmer error (e.g. record after dispose),
			// which we log defensively. Lifecycle log emission happens after
			// record() resolves so a logged "invocation.completed" implies the
			// commit either succeeded or was logged-and-dropped.
			state.emitTail = state.emitTail.then(async () => {
				try {
					await eventStore.record(widened);
				} catch (err) {
					logger.error("executor.event-store-record-failed", {
						id: widened.id,
						seq: widened.seq,
						kind: widened.kind,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				logInvocationLifecycle(widened, logger);
			});
		});
		state.wired = true;
		sandboxState.set(sb, state);
		return state;
	}

	function stateFor(sb: Sandbox): SandboxState {
		return sandboxState.get(sb) ?? initState(sb);
	}

	// biome-ignore lint/complexity/useMaxParams: invocation fan-in — owner, repo, workflow, descriptor, input, options are orthogonal and already packaged by the caller
	async function runInvocationWith(
		sb: Sandbox,
		state: SandboxState,
		owner: string,
		repo: string,
		workflow: WorkflowManifest,
		descriptor: TriggerDescriptor,
		input: unknown,
		options: InvokeOptions,
	): Promise<InvokeResult<unknown>> {
		const invocationId = newInvocationId();
		state.activeMeta = {
			id: invocationId,
			owner,
			repo,
			workflow: workflow.name,
			workflowSha: workflow.sha,
			dispatch: options.dispatch ?? { source: "trigger" },
		};
		// Secrets: manifest.secrets is decrypted once per sandbox by
		// sandbox-store (see packages/runtime/src/secrets/decrypt-workflow.ts)
		// and baked into the `secrets` plugin's config at construction. The
		// executor has no per-invocation crypto responsibility.
		let result: InvokeResult<unknown>;
		try {
			const runResult = await sb.run(descriptor.name, input);
			if (runResult.ok) {
				result = { ok: true, output: runResult.result };
			} else {
				result = {
					ok: false,
					error: {
						message: runResult.error.message,
						...(runResult.error.stack ? { stack: runResult.error.stack } : {}),
					},
				};
			}
		} catch (err) {
			result = {
				ok: false,
				error: {
					message: err instanceof Error ? err.message : String(err),
					...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
				},
			};
		} finally {
			state.activeMeta = null;
		}
		// Wait for all in-flight bus emits to settle so callers see a
		// "persistence committed before response" guarantee.
		await state.emitTail;
		return result;
	}

	return {
		// biome-ignore lint/complexity/useMaxParams: matches Executor.invoke contract
		async invoke(owner, repo, workflow, descriptor, input, options) {
			const sb = await sandboxStore.get(owner, workflow, options.bundleSource);
			const state = stateFor(sb);
			return state.runQueue.run(() =>
				runInvocationWith(
					sb,
					state,
					owner,
					repo,
					workflow,
					descriptor,
					input,
					options,
				),
			);
		},
		// biome-ignore lint/complexity/useMaxParams: matches Executor.fail contract
		async fail(owner, repo, workflow, descriptor, params) {
			// No sandbox lookup, no run queue, no `sb.onEvent` widener — the
			// pre-dispatch failure has nothing to run. Stamping happens in
			// the emitTriggerException primitive (the R-8 chokepoint).
			await emitTriggerException(
				eventStore,
				owner,
				repo,
				workflow,
				descriptor,
				params,
			);
		},
	};
}

export type { TriggerExceptionParams } from "./exception.js";
export type { RunQueue } from "./run-queue.js";
// biome-ignore lint/performance/noBarrelFile: executor entry point re-exports its siblings (run-queue, descriptors) so consumers have a single module to import from
export { createRunQueue } from "./run-queue.js";
export type {
	ActionDescriptor,
	BaseTriggerDescriptor,
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	InvokeResult,
	TriggerDescriptor,
} from "./types.js";
export type { Executor, ExecutorOptions, InvokeOptions };
export { createExecutor };
