import type { WorkflowRegistry } from "../workflow-registry.js";
import { TriggerKindIcon } from "./icons.js";
import type { TriggerPair } from "./invocations/removed-triggers.js";
import { REMOVED_KIND } from "./invocations/removed-triggers.js";

// ---------------------------------------------------------------------------
// Sidebar tree — single unified navigator for /invocations/* and /trigger/*
// ---------------------------------------------------------------------------
//
// One tree per page (no per-surface duplication). Tree links inherit the
// active surface so lateral navigation stays on the same surface; switching
// surface is the in-page tab strip's job, not the sidebar.
//
// Tree depth is 4 levels: owner → repo → workflow → trigger. Every node is
// a real anchor link to its scope page. Expansion is derived from the active
// URL — ancestors of the current route unfold, siblings stay collapsed —
// so there is no client-side toggle state.

type Surface = "/invocations" | "/trigger" | "/queue";

interface ActiveState {
	readonly owner?: string;
	readonly repo?: string;
	readonly workflow?: string;
	readonly trigger?: string;
}

interface TriggerRef {
	readonly trigger: string;
	readonly kind: string;
}

interface WorkflowGroup {
	readonly workflow: string;
	readonly triggers: readonly TriggerRef[];
	// Set when the whole workflow is gone from the registry but still has
	// invocation history (a fully-removed workflow). Drives muted styling +
	// sink-below-live sort. Trigger-level removeding rides TriggerRef.kind
	// === REMOVED_KIND instead (a workflow has no icon to carry the sentinel).
	readonly removed?: boolean;
}

interface SidebarData {
	readonly owners: readonly string[];
	readonly reposByOwner: Record<string, readonly string[]>;
	readonly workflowsByPair: Record<string, readonly WorkflowGroup[]>;
}

interface NodeCtx {
	readonly surface: Surface;
	readonly active: ActiveState;
}

function pairKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
}

function itemClass(base: string, active: boolean, open: boolean): string {
	const parts = [base];
	if (active) {
		parts.push("active");
	}
	if (open) {
		parts.push("open");
	}
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Trigger leaf
// ---------------------------------------------------------------------------

function TriggerLeaf({
	ctx,
	owner,
	repo,
	workflow,
	t,
}: {
	ctx: NodeCtx;
	owner: string;
	repo: string;
	workflow: string;
	t: TriggerRef;
}) {
	const isActive =
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		ctx.active.workflow === workflow &&
		ctx.active.trigger === t.trigger;
	const isRemoved = t.kind === REMOVED_KIND;
	const base = isRemoved
		? "sidebar-trigger sidebar-trigger--removed"
		: "sidebar-trigger";
	const title = isRemoved
		? `${workflow} / ${t.trigger} (removed — no longer in current upload)`
		: `${workflow} / ${t.trigger} (${t.kind})`;
	return (
		<li>
			<a
				class={itemClass(base, isActive, false)}
				href={`${ctx.surface}/${owner}/${repo}/${workflow}/${t.trigger}`}
				title={title}
			>
				<TriggerKindIcon kind={t.kind} />
				<span class="sidebar-trigger-name">{t.trigger}</span>
			</a>
		</li>
	);
}

// ---------------------------------------------------------------------------
// Workflow row
// ---------------------------------------------------------------------------

function WorkflowNode({
	ctx,
	owner,
	repo,
	group,
}: {
	ctx: NodeCtx;
	owner: string;
	repo: string;
	group: WorkflowGroup;
}) {
	const isActive =
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		ctx.active.workflow === group.workflow &&
		!ctx.active.trigger;
	const base = group.removed
		? "sidebar-workflow-link sidebar-workflow-link--removed"
		: "sidebar-workflow-link";
	const title = group.removed
		? `${group.workflow} (removed — no longer in current upload)`
		: undefined;
	return (
		<li>
			<a
				class={itemClass(base, isActive, true)}
				href={`${ctx.surface}/${owner}/${repo}/${group.workflow}`}
				title={title}
			>
				<span class="sidebar-workflow-label">{group.workflow}</span>
			</a>
			{ctx.surface === "/queue" ? null : (
				<ul class="sidebar-triggers">
					{group.triggers.map((t) => (
						<TriggerLeaf
							ctx={ctx}
							owner={owner}
							repo={repo}
							workflow={group.workflow}
							t={t}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------
// Repo row
// ---------------------------------------------------------------------------

function RepoNode({
	ctx,
	owner,
	repo,
	workflows,
}: {
	ctx: NodeCtx;
	owner: string;
	repo: string;
	workflows: readonly WorkflowGroup[];
}) {
	const isActive =
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		!ctx.active.workflow;
	if (workflows.length === 0) {
		return (
			<li>
				<a
					class={itemClass("sidebar-repo sidebar-repo--empty", isActive, false)}
					href={`${ctx.surface}/${owner}/${repo}`}
				>
					<span>{repo}</span>
					<span class="sidebar-note">no triggers</span>
				</a>
			</li>
		);
	}
	return (
		<li>
			<a
				class={itemClass("sidebar-repo-link", isActive, true)}
				href={`${ctx.surface}/${owner}/${repo}`}
			>
				<span class="sidebar-repo-label">{repo}</span>
			</a>
			<ul class="sidebar-workflows">
				{workflows.map((g) => (
					<WorkflowNode ctx={ctx} owner={owner} repo={repo} group={g} />
				))}
			</ul>
		</li>
	);
}

// ---------------------------------------------------------------------------
// Owner row
// ---------------------------------------------------------------------------

function OwnerNode({
	ctx,
	owner,
	repos,
	workflowsByPair,
}: {
	ctx: NodeCtx;
	owner: string;
	repos: readonly string[];
	workflowsByPair: Record<string, readonly WorkflowGroup[]>;
}) {
	const isActive = ctx.active.owner === owner && !ctx.active.repo;
	if (repos.length === 0) {
		return (
			<li class="sidebar-owner sidebar-owner--empty">
				<a
					class={itemClass("sidebar-owner-link", isActive, false)}
					href={`${ctx.surface}/${owner}`}
				>
					<span class="sidebar-owner-label">{owner}</span>
				</a>
				<span class="sidebar-note">no repos</span>
			</li>
		);
	}
	return (
		<li class={itemClass("sidebar-owner", false, true)}>
			<a
				class={itemClass("sidebar-owner-link", isActive, true)}
				href={`${ctx.surface}/${owner}`}
			>
				<span class="sidebar-owner-label">{owner}</span>
			</a>
			<ul class="sidebar-repos">
				{repos.map((r) => (
					<RepoNode
						ctx={ctx}
						owner={owner}
						repo={r}
						workflows={workflowsByPair[pairKey(owner, r)] ?? []}
					/>
				))}
			</ul>
		</li>
	);
}

// ---------------------------------------------------------------------------
// Top-level: render the unified tree for the active surface.
// ---------------------------------------------------------------------------

function SidebarTree({
	surface,
	data,
	active,
}: {
	surface: Surface;
	data: SidebarData;
	active: ActiveState;
}) {
	const { owners, reposByOwner, workflowsByPair } = data;
	const ctx: NodeCtx = { surface, active };
	if (owners.length === 0) {
		return <div class="sidebar-tree-empty">No owners available</div>;
	}
	return (
		<ul class="sidebar-tree">
			{owners.map((o) => (
				<OwnerNode
					ctx={ctx}
					owner={o}
					repos={reposByOwner[o] ?? []}
					workflowsByPair={workflowsByPair}
				/>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Data collector — single source for both surfaces
// ---------------------------------------------------------------------------

// Mutable building shapes — the exported SidebarData carries readonly arrays,
// but the union pass below pushes into per-repo/per-workflow buffers.
interface MutableGroup {
	workflow: string;
	triggers: TriggerRef[];
	removed?: boolean;
}

function liveTriggerKey(workflow: string, trigger: string): string {
	// NUL separator — illegal in workflow/trigger names, so it cannot collide
	// with a name that embeds the literal characters of another pair.
	return `${workflow} ${trigger}`;
}

interface LiveSets {
	readonly triggers: Set<string>;
	readonly workflows: Set<string>;
}

// Mutable accumulator threaded through the removed-merge pass.
interface Acc {
	readonly reposByOwner: Record<string, string[]>;
	readonly byRepo: Record<string, MutableGroup[]>;
}

function liveSetsFor(registry: WorkflowRegistry, owner: string, repo: string) {
	const triggers = new Set<string>();
	const workflows = new Set<string>();
	for (const entry of registry.list(owner, repo)) {
		workflows.add(entry.workflow.name);
		for (const d of entry.triggers) {
			triggers.add(liveTriggerKey(entry.workflow.name, d.name));
		}
	}
	return { triggers, workflows } satisfies LiveSets;
}

// Get-or-create the group buffer for a repo, registering an event-only repo
// (one absent from registry.repos) under its owner when first seen.
function ensureRepoGroups(
	acc: Acc,
	owner: string,
	repo: string,
): MutableGroup[] {
	const pk = pairKey(owner, repo);
	const existing = acc.byRepo[pk];
	if (existing) {
		return existing;
	}
	const groups: MutableGroup[] = [];
	acc.byRepo[pk] = groups;
	const repos = acc.reposByOwner[owner] ?? [];
	acc.reposByOwner[owner] = repos;
	if (!repos.includes(repo)) {
		repos.push(repo);
	}
	return groups;
}

function ensureGroup(
	groups: MutableGroup[],
	workflow: string,
	workflowIsLive: boolean,
): MutableGroup {
	const existing = groups.find((g) => g.workflow === workflow);
	if (existing) {
		return existing;
	}
	const group: MutableGroup = workflowIsLive
		? { workflow, triggers: [] }
		: { workflow, triggers: [], removed: true };
	groups.push(group);
	return group;
}

// Fold removed pairs (those whose (workflow, trigger) is absent from the
// registry) into the live per-repo group buffers, creating removed workflow
// groups and event-only repos as needed. Mutates `acc`.
function mergeRemovedPairs(
	registry: WorkflowRegistry,
	owners: readonly string[],
	acc: Acc,
	triggerPairs: readonly TriggerPair[],
): void {
	const ownerSet = new Set(owners);
	const liveByRepo = new Map<string, LiveSets>();
	const liveFor = (owner: string, repo: string): LiveSets => {
		const pk = pairKey(owner, repo);
		const cached = liveByRepo.get(pk);
		if (cached) {
			return cached;
		}
		const live = liveSetsFor(registry, owner, repo);
		liveByRepo.set(pk, live);
		return live;
	};
	for (const pair of triggerPairs) {
		if (!ownerSet.has(pair.owner)) {
			continue;
		}
		const live = liveFor(pair.owner, pair.repo);
		if (live.triggers.has(liveTriggerKey(pair.workflow, pair.name))) {
			continue; // still a live trigger — already in the tree
		}
		const groups = ensureRepoGroups(acc, pair.owner, pair.repo);
		const group = ensureGroup(
			groups,
			pair.workflow,
			live.workflows.has(pair.workflow),
		);
		if (!group.triggers.some((t) => t.trigger === pair.name)) {
			group.triggers.push({ trigger: pair.name, kind: REMOVED_KIND });
		}
	}
}

// Live entries first (original registry order), removed after — and removeds
// sorted by name so their order is deterministic (the removed-pairs query
// returns rows in arbitrary order; without this the sidebar would reshuffle
// dead nodes between renders).
function sinkRemoved<T>(
	items: T[],
	isRemoved: (item: T) => boolean,
	nameOf: (item: T) => string,
): T[] {
	const live = items.filter((i) => !isRemoved(i));
	const removed = items
		.filter(isRemoved)
		.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
	return [...live, ...removed];
}

function buildSidebarData(
	registry: WorkflowRegistry,
	owners: readonly string[],
	triggerPairs?: readonly TriggerPair[],
): SidebarData {
	const reposByOwner: Record<string, string[]> = {};
	const byRepo: Record<string, MutableGroup[]> = {};
	for (const owner of owners) {
		const repos = [...registry.repos(owner)];
		reposByOwner[owner] = repos;
		for (const repo of repos) {
			const groups: MutableGroup[] = [];
			for (const entry of registry.list(owner, repo)) {
				const triggers: TriggerRef[] = entry.triggers.map((d) => ({
					trigger: d.name,
					kind: d.kind,
				}));
				groups.push({ workflow: entry.workflow.name, triggers });
			}
			byRepo[pairKey(owner, repo)] = groups;
		}
	}
	if (triggerPairs && triggerPairs.length > 0) {
		mergeRemovedPairs(registry, owners, { reposByOwner, byRepo }, triggerPairs);
	}
	// Finalise: sink removeds below live siblings at the trigger and workflow
	// levels (removed-only repos are already appended after live repos).
	const workflowsByPair: Record<string, WorkflowGroup[]> = {};
	for (const [pk, groups] of Object.entries(byRepo)) {
		workflowsByPair[pk] = sinkRemoved(
			groups.map((g) => ({
				workflow: g.workflow,
				triggers: sinkRemoved(
					g.triggers,
					(t) => t.kind === REMOVED_KIND,
					(t) => t.trigger,
				),
				...(g.removed ? { removed: true } : {}),
			})),
			(g) => g.removed === true,
			(g) => g.workflow,
		);
	}
	return { owners, reposByOwner, workflowsByPair };
}

export type { ActiveState, SidebarData, TriggerRef, WorkflowGroup };
export { buildSidebarData, SidebarTree };
