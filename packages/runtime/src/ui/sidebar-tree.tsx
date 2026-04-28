import type { Child } from "hono/jsx";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { ChevronIcon, TriggerKindIcon } from "./icons.js";

// ---------------------------------------------------------------------------
// Sidebar tree — persistent navigation for /dashboard/* and /trigger/*
// ---------------------------------------------------------------------------
//
// Both surfaces share the same `owner → repo → trigger` shape. The leaf
// URL differs by surface:
//   - Dashboard: /dashboard/:owner/:repo/:workflow/:trigger
//       → filters the invocation list to that trigger
//   - Trigger:   /trigger/:owner/:repo/:workflow/:trigger
//       → renders the single pre-expanded trigger card
//
// Expansion is derived from the active URL — ancestors of the current
// route unfold, siblings stay collapsed — so there is no client-side
// toggle state and a reload always shows the tree in the same shape.

interface TriggerRef {
	readonly workflow: string;
	readonly trigger: string;
	readonly kind: string;
}

type Surface = "/dashboard" | "/trigger";

interface ActiveState {
	readonly surface: Surface;
	readonly owner?: string;
	readonly repo?: string;
	readonly workflow?: string;
	readonly trigger?: string;
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

interface SectionCtx {
	readonly surface: Surface;
	readonly active: ActiveState;
}

interface SidebarData {
	readonly owners: readonly string[];
	readonly reposByOwner: Record<string, readonly string[]>;
	readonly triggersByPair: Record<string, readonly TriggerRef[]>;
}

// ---------------------------------------------------------------------------
// Trigger leaf (shared: leads to filter-by-trigger on dashboard, single card
// view on trigger)
// ---------------------------------------------------------------------------

function TriggerLeaf({
	ctx,
	owner,
	repo,
	t,
}: {
	ctx: SectionCtx;
	owner: string;
	repo: string;
	t: TriggerRef;
}) {
	const isActive =
		ctx.active.surface === ctx.surface &&
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		ctx.active.workflow === t.workflow &&
		ctx.active.trigger === t.trigger;
	return (
		<li>
			<a
				class={itemClass("sidebar-trigger", isActive, false)}
				href={`${ctx.surface}/${owner}/${repo}/${t.workflow}/${t.trigger}`}
				title={`${t.workflow} / ${t.trigger} (${t.kind})`}
			>
				<TriggerKindIcon kind={t.kind} />
				<span class="sidebar-trigger-name">{t.trigger}</span>
			</a>
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
	triggers,
}: {
	ctx: SectionCtx;
	owner: string;
	repo: string;
	triggers: readonly TriggerRef[];
}) {
	const isActiveSurface = ctx.active.surface === ctx.surface;
	const isActive =
		isActiveSurface &&
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		!ctx.active.trigger;
	const isOpen =
		isActiveSurface && ctx.active.owner === owner && ctx.active.repo === repo;
	if (triggers.length === 0) {
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
				class={itemClass("sidebar-repo-link", isActive, isOpen)}
				href={`${ctx.surface}/${owner}/${repo}`}
			>
				<span class="sidebar-chevron" aria-hidden="true">
					<ChevronIcon />
				</span>
				<span class="sidebar-repo-label">{repo}</span>
			</a>
			{isOpen && (
				<ul class="sidebar-triggers">
					{triggers.map((t) => (
						<TriggerLeaf ctx={ctx} owner={owner} repo={repo} t={t} />
					))}
				</ul>
			)}
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
	triggersByPair,
}: {
	ctx: SectionCtx;
	owner: string;
	repos: readonly string[];
	triggersByPair: Record<string, readonly TriggerRef[]>;
}) {
	const isActiveSurface = ctx.active.surface === ctx.surface;
	const isActive =
		isActiveSurface && ctx.active.owner === owner && !ctx.active.repo;
	const isOpen = isActiveSurface && ctx.active.owner === owner;
	if (repos.length === 0) {
		return (
			<li class="sidebar-owner sidebar-owner--empty">
				<a
					class={itemClass("sidebar-owner-link", isActive, false)}
					href={`${ctx.surface}/${owner}`}
				>
					<span class="sidebar-chevron-placeholder" />
					<span class="sidebar-owner-label">{owner}</span>
				</a>
				<span class="sidebar-note">no repos</span>
			</li>
		);
	}
	return (
		<li class={itemClass("sidebar-owner", false, isOpen)}>
			<a
				class={itemClass("sidebar-owner-link", isActive, isOpen)}
				href={`${ctx.surface}/${owner}`}
			>
				<span class="sidebar-chevron" aria-hidden="true">
					<ChevronIcon />
				</span>
				<span class="sidebar-owner-label">{owner}</span>
			</a>
			{isOpen && (
				<ul class="sidebar-repos">
					{repos.map((r) => (
						<RepoNode
							ctx={ctx}
							owner={owner}
							repo={r}
							triggers={triggersByPair[pairKey(owner, r)] ?? []}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------
// Section — full tree for a single surface
// ---------------------------------------------------------------------------

function Section({ ctx, data }: { ctx: SectionCtx; data: SidebarData }) {
	const { owners, reposByOwner, triggersByPair } = data;
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
					triggersByPair={triggersByPair}
				/>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Top-level: render both sections
// ---------------------------------------------------------------------------

function SidebarBoth({
	data,
	active,
}: {
	data: SidebarData;
	active: ActiveState;
}) {
	const dashboardActive = active.surface === "/dashboard";
	const triggerActive = active.surface === "/trigger";
	return (
		<>
			<div class={`sidebar-section${dashboardActive ? " active" : ""}`}>
				<a class="sidebar-section-title" href="/dashboard">
					Dashboard
				</a>
				<Section ctx={{ surface: "/dashboard", active }} data={data} />
			</div>
			<div class={`sidebar-section${triggerActive ? " active" : ""}`}>
				<a class="sidebar-section-title" href="/trigger">
					Trigger
				</a>
				<Section ctx={{ surface: "/trigger", active }} data={data} />
			</div>
		</>
	);
}

// Compat shim — un-migrated middleware (dashboard/middleware.ts,
// trigger/middleware.ts) calls renderSidebarBoth(data, active) and threads
// the result into renderLayout's sidebarTree slot. The returned value is a
// JSX node passed as a prop, so it's not stringified yet — the parent
// Layout's render walks it. To delete once those middleware files switch
// to <SidebarBoth ...> directly.
function renderSidebarBoth(data: SidebarData, active: ActiveState): Child {
	return <SidebarBoth data={data} active={active} />;
}

// ---------------------------------------------------------------------------
// Data collector — single source for both middlewares
// ---------------------------------------------------------------------------

function buildSidebarData(
	registry: WorkflowRegistry,
	owners: readonly string[],
): SidebarData {
	const reposByOwner: Record<string, readonly string[]> = {};
	const triggersByPair: Record<string, TriggerRef[]> = {};
	for (const owner of owners) {
		const repos = registry.repos(owner);
		reposByOwner[owner] = repos;
		for (const repo of repos) {
			const bucket: TriggerRef[] = [];
			for (const entry of registry.list(owner, repo)) {
				for (const descriptor of entry.triggers) {
					bucket.push({
						workflow: entry.workflow.name,
						trigger: descriptor.name,
						kind: descriptor.kind,
					});
				}
			}
			triggersByPair[pairKey(owner, repo)] = bucket;
		}
	}
	return { owners, reposByOwner, triggersByPair };
}

export type { ActiveState, SidebarData, TriggerRef };
export { buildSidebarData, renderSidebarBoth, SidebarBoth };
