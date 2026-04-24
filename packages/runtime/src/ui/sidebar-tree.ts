import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { triggerKindIcon } from "./triggers.js";

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

const chevronIconSvg = raw(
	// biome-ignore lint/security/noSecrets: inline SVG markup, not a secret
	'<svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
);

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

// ---------------------------------------------------------------------------
// Trigger leaf (shared: leads to filter-by-trigger on dashboard, single card
// view on trigger)
// ---------------------------------------------------------------------------

function renderTriggerLeaf(
	ctx: SectionCtx,
	owner: string,
	repo: string,
	t: TriggerRef,
) {
	const isActive =
		ctx.active.surface === ctx.surface &&
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		ctx.active.workflow === t.workflow &&
		ctx.active.trigger === t.trigger;
	return html`<li>
    <a class="${itemClass("sidebar-trigger", isActive, false)}"
       href="${ctx.surface}/${owner}/${repo}/${t.workflow}/${t.trigger}"
       title="${t.workflow} / ${t.trigger} (${t.kind})">
      ${triggerKindIcon(t.kind)}
      <span class="sidebar-trigger-name">${t.trigger}</span>
    </a>
  </li>`;
}

// ---------------------------------------------------------------------------
// Repo row
// ---------------------------------------------------------------------------

function renderRepoNode(
	ctx: SectionCtx,
	owner: string,
	repo: string,
	triggers: readonly TriggerRef[],
) {
	const isActiveSurface = ctx.active.surface === ctx.surface;
	const isActive =
		isActiveSurface &&
		ctx.active.owner === owner &&
		ctx.active.repo === repo &&
		!ctx.active.trigger;
	const isOpen =
		isActiveSurface && ctx.active.owner === owner && ctx.active.repo === repo;
	if (triggers.length === 0) {
		return html`<li>
      <a class="${itemClass("sidebar-repo sidebar-repo--empty", isActive, false)}"
         href="${ctx.surface}/${owner}/${repo}">
        <span>${repo}</span>
        <span class="sidebar-note">no triggers</span>
      </a>
    </li>`;
	}
	return html`<li>
    <a class="${itemClass("sidebar-repo-link", isActive, isOpen)}"
       href="${ctx.surface}/${owner}/${repo}">
      <span class="sidebar-chevron" aria-hidden="true">${chevronIconSvg}</span>
      <span class="sidebar-repo-label">${repo}</span>
    </a>
    ${
			isOpen
				? html`<ul class="sidebar-triggers">
          ${triggers.map((t) => renderTriggerLeaf(ctx, owner, repo, t))}
        </ul>`
				: ""
		}
  </li>`;
}

// ---------------------------------------------------------------------------
// Owner row
// ---------------------------------------------------------------------------

function renderOwnerNode(
	ctx: SectionCtx,
	owner: string,
	repos: readonly string[],
	triggersByPair: Record<string, readonly TriggerRef[]>,
) {
	const isActiveSurface = ctx.active.surface === ctx.surface;
	const isActive =
		isActiveSurface && ctx.active.owner === owner && !ctx.active.repo;
	const isOpen = isActiveSurface && ctx.active.owner === owner;
	if (repos.length === 0) {
		return html`<li class="sidebar-owner sidebar-owner--empty">
      <a class="${itemClass("sidebar-owner-link", isActive, false)}"
         href="${ctx.surface}/${owner}">
        <span class="sidebar-chevron-placeholder"></span>
        <span class="sidebar-owner-label">${owner}</span>
      </a>
      <span class="sidebar-note">no repos</span>
    </li>`;
	}
	return html`<li class="${itemClass("sidebar-owner", false, isOpen)}">
    <a class="${itemClass("sidebar-owner-link", isActive, isOpen)}"
       href="${ctx.surface}/${owner}">
      <span class="sidebar-chevron" aria-hidden="true">${chevronIconSvg}</span>
      <span class="sidebar-owner-label">${owner}</span>
    </a>
    ${
			isOpen
				? html`<ul class="sidebar-repos">
          ${repos.map((r) =>
						renderRepoNode(
							ctx,
							owner,
							r,
							triggersByPair[pairKey(owner, r)] ?? [],
						),
					)}
        </ul>`
				: ""
		}
  </li>`;
}

// ---------------------------------------------------------------------------
// Section — full tree for a single surface
// ---------------------------------------------------------------------------

function renderSection(ctx: SectionCtx, data: SidebarData) {
	const { owners, reposByOwner, triggersByPair } = data;
	return owners.length === 0
		? html`<div class="sidebar-tree-empty">No owners available</div>`
		: html`<ul class="sidebar-tree">
        ${owners.map((o) =>
					renderOwnerNode(ctx, o, reposByOwner[o] ?? [], triggersByPair),
				)}
      </ul>`;
}

// ---------------------------------------------------------------------------
// Top-level: render both sections
// ---------------------------------------------------------------------------

interface SidebarData {
	readonly owners: readonly string[];
	readonly reposByOwner: Record<string, readonly string[]>;
	readonly triggersByPair: Record<string, readonly TriggerRef[]>;
}

function renderSidebarBoth(
	data: SidebarData,
	active: ActiveState,
): HtmlEscapedString {
	const dashboardTree = renderSection({ surface: "/dashboard", active }, data);
	const triggerTree = renderSection({ surface: "/trigger", active }, data);
	const dashboardActive = active.surface === "/dashboard";
	const triggerActive = active.surface === "/trigger";
	return html`<div class="sidebar-section${dashboardActive ? " active" : ""}">
    <a class="sidebar-section-title" href="/dashboard">Dashboard</a>
    ${dashboardTree}
  </div>
  <div class="sidebar-section${triggerActive ? " active" : ""}">
    <a class="sidebar-section-title" href="/trigger">Trigger</a>
    ${triggerTree}
  </div>` as HtmlEscapedString;
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
export { buildSidebarData, renderSidebarBoth };
