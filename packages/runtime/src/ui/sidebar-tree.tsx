import type { WorkflowRegistry } from "../workflow-registry.js";
import { TriggerKindIcon } from "./icons.js";

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

type Surface = "/invocations" | "/trigger";

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
	return (
		<li>
			<a
				class={itemClass("sidebar-trigger", isActive, false)}
				href={`${ctx.surface}/${owner}/${repo}/${workflow}/${t.trigger}`}
				title={`${workflow} / ${t.trigger} (${t.kind})`}
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
	return (
		<li>
			<a
				class={itemClass("sidebar-workflow-link", isActive, true)}
				href={`${ctx.surface}/${owner}/${repo}/${group.workflow}`}
			>
				<span class="sidebar-workflow-label">{group.workflow}</span>
			</a>
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

function buildSidebarData(
	registry: WorkflowRegistry,
	owners: readonly string[],
): SidebarData {
	const reposByOwner: Record<string, readonly string[]> = {};
	const workflowsByPair: Record<string, WorkflowGroup[]> = {};
	for (const owner of owners) {
		const repos = registry.repos(owner);
		reposByOwner[owner] = repos;
		for (const repo of repos) {
			const groups: WorkflowGroup[] = [];
			for (const entry of registry.list(owner, repo)) {
				const triggers: TriggerRef[] = entry.triggers.map((d) => ({
					trigger: d.name,
					kind: d.kind,
				}));
				groups.push({ workflow: entry.workflow.name, triggers });
			}
			workflowsByPair[pairKey(owner, repo)] = groups;
		}
	}
	return { owners, reposByOwner, workflowsByPair };
}

export type { ActiveState, SidebarData, TriggerRef, WorkflowGroup };
export { buildSidebarData, SidebarTree };
