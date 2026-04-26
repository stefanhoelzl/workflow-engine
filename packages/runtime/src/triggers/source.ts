import type { DispatchMeta } from "@workflow-engine/core";
import type { TriggerExceptionParams } from "../executor/exception.js";
import type { BaseTriggerDescriptor, InvokeResult } from "../executor/types.js";

// ---------------------------------------------------------------------------
// TriggerSource — the per-kind protocol adapter contract.
// ---------------------------------------------------------------------------
//
// Every trigger kind (http, cron, future imap, ...) ships a TriggerSource
// implementation. The runtime (main.ts) constructs one backend per kind with
// shared deps, passes the list into the WorkflowRegistry, and manages
// start()/stop() lifecycle.
//
// On every repo-upload the registry calls `reconfigure(owner, repo, entries)`
// on every backend in parallel. Each backend replaces its per-(owner, repo)
// state atomically; empty entries removes the repo. Backends never touch the
// Executor or the EventBus directly — they invoke `entry.fire(input)` for
// handler dispatch and `entry.exception(params)` for author-fixable
// pre-dispatch failures. Both closures are constructed by the registry
// (`buildFire`, `buildException`) and bound to identity at construction
// time.

interface TriggerEntry<
	D extends BaseTriggerDescriptor<string> = BaseTriggerDescriptor<string>,
> {
	readonly descriptor: D;
	// Backends call `fire(input)` with no second argument — the default
	// dispatch `{ source: "trigger" }` is applied inside buildFire. Only the
	// kind-agnostic UI endpoint at `/trigger/*` passes a dispatch, and only
	// with `source: "manual"`.
	readonly fire: (
		input: unknown,
		dispatch?: DispatchMeta,
	) => Promise<InvokeResult<unknown>>;
	// Backends call `exception(params)` to surface *author-fixable
	// pre-dispatch failures* (IMAP misconfig, broken cron expression,
	// etc.) into the dashboard. Each call produces exactly one
	// `trigger.exception` leaf event on the bus, fully stamped with this
	// entry's identity. Engine-bug failures (e.g. `entry.fire` itself
	// throws) do NOT route through here — they stay log-only via
	// `Logger.error` at the call site. See `triggers` spec
	// "Backend surfaces pre-dispatch failure via entry.exception".
	readonly exception: (params: TriggerExceptionParams) => Promise<void>;
}

// User-facing configuration error. Maps to 4xx on the upload API. Never
// carries stack traces or credentials — only safe, actionable fields that
// can be surfaced to the owner who uploaded the bundle.
interface TriggerConfigError {
	readonly backend: string;
	readonly trigger: string;
	readonly message: string;
}

type ReconfigureResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly errors: readonly TriggerConfigError[] };

interface TriggerSource<
	K extends string = string,
	D extends BaseTriggerDescriptor<K> = BaseTriggerDescriptor<K>,
> {
	readonly kind: K;
	start(): Promise<void>;
	stop(): Promise<void>;
	reconfigure(
		owner: string,
		repo: string,
		entries: readonly TriggerEntry<D>[],
	): Promise<ReconfigureResult>;
}

export type {
	ReconfigureResult,
	TriggerConfigError,
	TriggerEntry,
	TriggerSource,
};
