import type { WorkflowManifest } from "@workflow-engine/core";
import type { Executor, TriggerExceptionParams } from "../executor/index.js";
import type { TriggerDescriptor } from "../executor/types.js";

// ---------------------------------------------------------------------------
// buildException — construct the `exception(params)` closure for one
// TriggerEntry. Sibling to `buildFire`.
// ---------------------------------------------------------------------------
//
// Backends receive `TriggerEntry { descriptor, fire, exception }`. Calling
// `exception(params)` with `{ name, error, details? }` produces exactly one
// `trigger.exception` leaf event on the bus, fully stamped with the
// trigger's identity (owner / repo / workflow / workflowSha / a fresh
// `evt_*` invocationId). Identity is bound here at construction time;
// `name`, `error`, and `details` are call-time so a single source can
// surface multiple failure categories (current "imap.poll-failed" plus
// any future kinds) without re-binding.
//
// The closure delegates to `executor.fail`, which owns the stamping
// primitive. Backends never call `executor.fail` directly — the entire
// point of `buildException` is to keep `TriggerSource` implementations
// free of executor and bus references (see `triggers` spec
// "TriggerEntry carries descriptor and fire callback" and `executor`
// spec "Executor is called only from fire closures"; both modified by
// the trigger-exception-event-kind change).

// biome-ignore lint/complexity/useMaxParams: identity-bag mirrors buildFire
function buildException(
	executor: Executor,
	owner: string,
	repo: string,
	workflow: WorkflowManifest,
	descriptor: TriggerDescriptor,
): (params: TriggerExceptionParams) => Promise<void> {
	return (params) => executor.fail(owner, repo, workflow, descriptor, params);
}

export { buildException };
