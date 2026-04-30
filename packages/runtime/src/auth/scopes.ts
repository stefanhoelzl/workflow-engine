import type { Scope } from "../event-store.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { ownerSet, validateOwner, validateRepo } from "./owner.js";
import type { UserContext } from "./user-context.js";

// ---------------------------------------------------------------------------
// resolveQueryScopes — central policy boundary for EventStore reads
// ---------------------------------------------------------------------------
//
// Returns the allow-list of `(owner, repo)` pairs the supplied user may
// query events for:
//
//   1. Start from every registered bundle (`registry.pairs()`).
//   2. Intersect with the user's owner-membership set (authenticated user
//      only — dev/open mode falls back to every registered owner).
//   3. Optionally narrow by a caller-supplied `constraint` (dashboard-style
//      drill-down, e.g. `{ owner: "acme" }` or `{ owner: "acme", repo: "foo" }`).
//      The constraint MAY come from URL segments; it is filtered against the
//      membership-derived allow-set, not trusted directly.
//
// Every `EventStore.query` call in the runtime routes through this helper so
// that SECURITY.md §1 I-T2 (owner + repo isolation) has a single audited
// source of truth. Constructing raw scopes elsewhere is forbidden.

interface ScopeConstraint {
	readonly owner?: string;
	readonly repo?: string;
}

function resolveQueryScopes(
	user: UserContext | undefined,
	registry: WorkflowRegistry,
	constraint?: ScopeConstraint,
): Scope[] {
	const allowedOwners = user
		? ownerSet(user)
		: // Dev/open-mode fallback: when no user is present, every registered
			// owner is visible. Production paths always have a session cookie
			// (oauth2-proxy forward-auth on UI routes; provider dispatch on
			// API routes), so this branch is only reachable in open-mode
			// local development.
			new Set(registry.owners().filter((o) => validateOwner(o)));

	const constrainedOwner = constraint?.owner;
	const constrainedRepo = constraint?.repo;
	if (constrainedOwner !== undefined && !validateOwner(constrainedOwner)) {
		return [];
	}
	if (constrainedRepo !== undefined && !validateRepo(constrainedRepo)) {
		return [];
	}

	const out: Scope[] = [];
	for (const pair of registry.pairs()) {
		if (!allowedOwners.has(pair.owner)) {
			continue;
		}
		if (constrainedOwner !== undefined && pair.owner !== constrainedOwner) {
			continue;
		}
		if (constrainedRepo !== undefined && pair.repo !== constrainedRepo) {
			continue;
		}
		out.push({ owner: pair.owner, repo: pair.repo });
	}
	return out;
}

export type { ScopeConstraint };
export { resolveQueryScopes };
