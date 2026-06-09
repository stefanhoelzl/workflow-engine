import type { EventStore, Scope } from "../../event-store.js";

// ---------------------------------------------------------------------------
// Removed-invocation discovery
// ---------------------------------------------------------------------------
//
// An removed is a (workflow, name) pair that produced invocation history but is
// no longer present in the WorkflowRegistry — a removed or renamed trigger (or
// a fully-removed workflow). These two read shapes back the invocations-surface
// removed affordances:
//
//   - `queryTriggerPairs` feeds the sidebar tree reconstruction (a global,
//     complete, deduped set of pairs across the user's scopes). It reads from
//     `trigger.request` only — that event carries the trigger declaration name
//     in its `name` column (see plugins/trigger.ts). `trigger.exception` /
//     `trigger.rejection` stamp the trigger name into `input.trigger`, not the
//     `name` column, so a trigger that ONLY ever failed pre-dispatch will lack
//     a sidebar node; its history stays reachable by URL via the relaxed route
//     guard below and in the repo-wide flat list.
//
//   - `workflowHistoryExists` is the route guard's bounded existence probe:
//     "does any event exist for this (owner, repo, workflow)?". It spans every
//     kind (including synthetic leaves) so a removed workflow whose only trace
//     is a `system.upload` or `trigger.exception` still resolves 200. The probe
//     is workflow-level only — the :trigger URL segment is never validated for
//     existence (it just narrows the query), so trigger.exception history
//     (whose trigger name lives in `input.trigger`, not `name`) is never
//     wrongly 404'd.

interface TriggerPair {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly name: string;
}

// Sentinel trigger-kind value for a removed/renamed trigger. Drives the
// archive-box icon, muted styling, and sink-below-live sort wherever a kind is
// surfaced. Reserved — a live trigger descriptor never carries this kind.
const REMOVED_KIND = "removed";

// Distinct (owner, repo, workflow, name) pairs that have produced a
// `trigger.request` across the given scopes. No limit — the cardinality is
// bounded by the number of trigger names that ever ran, not the run count.
async function queryTriggerPairs(
	eventStore: EventStore,
	scopes: readonly Scope[],
): Promise<TriggerPair[]> {
	if (scopes.length === 0) {
		return [];
	}
	return (await eventStore
		.query(scopes)
		.where("kind", "=", "trigger.request")
		.select(["owner", "repo", "workflow", "name"])
		.distinct()
		.execute()) as TriggerPair[];
}

// Bounded existence probe for the `:workflow` route guard. True if any event
// exists for (owner, repo, workflow); spans all kinds so synthetic history
// counts. `LIMIT 1`, never a full scan.
async function workflowHistoryExists(
	eventStore: EventStore,
	owner: string,
	repo: string,
	workflow: string,
): Promise<boolean> {
	const row = await eventStore
		.query([{ owner, repo }])
		.where("workflow", "=", workflow)
		.select("id")
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

export type { TriggerPair };
export { queryTriggerPairs, REMOVED_KIND, workflowHistoryExists };
