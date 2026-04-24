import type { ManualTriggerDescriptor } from "../executor/types.js";
import type {
	ReconfigureResult,
	TriggerEntry,
	TriggerSource,
} from "./source.js";

// ---------------------------------------------------------------------------
// Manual TriggerSource
// ---------------------------------------------------------------------------
//
// The manual backend is intentionally quiescent: it holds no per-(owner, repo)
// state, registers no HTTP route, and arms no timer. The only path through
// which a manual trigger fires is the authenticated
// `/trigger/<owner>/<repo>/<workflow>/<trigger>` UI endpoint, which resolves
// entries via `registry.getEntry` and calls `entry.fire(body)` directly. This
// source exists solely to satisfy the "every kind has a registered backend"
// invariant that `reconfigureBackends` depends on.

type ManualTriggerSource = TriggerSource<"manual", ManualTriggerDescriptor>;

function createManualTriggerSource(): ManualTriggerSource {
	return {
		kind: "manual",
		start(): Promise<void> {
			return Promise.resolve();
		},
		stop(): Promise<void> {
			return Promise.resolve();
		},
		reconfigure(
			_owner: string,
			_repo: string,
			_entries: readonly TriggerEntry<ManualTriggerDescriptor>[],
		): Promise<ReconfigureResult> {
			return Promise.resolve({ ok: true });
		},
	};
}

export type { ManualTriggerSource };
export { createManualTriggerSource };
