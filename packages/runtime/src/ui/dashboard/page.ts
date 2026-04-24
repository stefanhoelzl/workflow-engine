import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { renderLayout } from "../layout.js";
import { triggerKindIcon } from "../triggers.js";

const US_PER_MS = 1000;
const US_PER_SECOND = 1_000_000;
const US_PER_MINUTE = 60_000_000;
const DURATION_FRACTION_DIGITS = 1;

interface InvocationRow {
	readonly id: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly status: string;
	readonly startedAt: string | Date;
	readonly completedAt: string | Date | null;
	readonly startedTs: number;
	readonly completedTs: number | null;
	readonly triggerKind?: string;
	readonly dispatch?: {
		readonly source: "manual" | "trigger";
		readonly user?: { readonly login: string };
	};
}

// Flat-list sort order:
//   1. pending rows first (newest-started on top)
//   2. terminal rows after (newest-completed on top)
// Rationale: a pending invocation is "live" and almost always the thing the
// operator wants to see; completed rows decay into history.
function sortInvocationRows(rows: readonly InvocationRow[]): InvocationRow[] {
	return rows.slice().sort((a, b) => {
		const aPending = a.status === "pending";
		const bPending = b.status === "pending";
		if (aPending !== bPending) {
			return aPending ? -1 : 1;
		}
		if (aPending) {
			return b.startedTs - a.startedTs;
		}
		return (b.completedTs ?? 0) - (a.completedTs ?? 0);
	});
}

function toIsoString(ts: string | Date): string {
	const d = ts instanceof Date ? ts : new Date(ts);
	return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

function renderTime(ts: string | Date, className: string) {
	const iso = toIsoString(ts);
	return html`<time class="${className}" datetime="${iso}">${iso}</time>`;
}

function formatDurationUs(us: number): string {
	const d = Math.max(0, us);
	if (d < US_PER_MS) {
		return `${d} µs`;
	}
	if (d < US_PER_SECOND) {
		return `${(d / US_PER_MS).toFixed(DURATION_FRACTION_DIGITS)} ms`;
	}
	if (d < US_PER_MINUTE) {
		return `${(d / US_PER_SECOND).toFixed(DURATION_FRACTION_DIGITS)} s`;
	}
	return `${(d / US_PER_MINUTE).toFixed(DURATION_FRACTION_DIGITS)} min`;
}

const chevronIconSvg = raw(
	// biome-ignore lint/security/noSecrets: inline SVG markup, not a secret
	'<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
);

function renderDispatchChip(dispatch: InvocationRow["dispatch"]) {
	if (!dispatch || dispatch.source !== "manual") {
		return "";
	}
	const tooltip = dispatch.user?.login ?? "";
	return html`<span class="entry-dispatch" title="${tooltip}">manual</span>`;
}

function renderCardSummary(
	row: InvocationRow,
	duration: string,
	expandable: boolean,
) {
	const kindIcon = row.triggerKind ? triggerKindIcon(row.triggerKind) : "";
	const chevron = expandable
		? html`<span class="entry-expand-chevron" aria-hidden="true">${chevronIconSvg}</span>`
		: html`<span class="entry-expand-chevron entry-expand-chevron--placeholder" aria-hidden="true"></span>`;
	return html`<div class="entry-header">
      ${chevron}
      <div class="entry-identity">
        ${kindIcon}
        <span class="entry-scope">${row.owner}/${row.repo}</span>
        <span class="entry-identity-sep">›</span>
        <span class="entry-workflow">${row.workflow}</span>
        <span class="entry-identity-sep">›</span>
        <span class="entry-trigger">${row.trigger}</span>
      </div>
      ${renderDispatchChip(row.dispatch)}
      <span class="badge ${row.status}">${row.status}</span>
    </div>
    <div class="entry-meta">
      ${renderTime(row.startedAt, "entry-started")}
      <span class="entry-sep">·</span>
      <span class="entry-duration">${duration}</span>
    </div>`;
}

function renderCard(row: InvocationRow) {
	const duration =
		row.completedTs === null
			? "—"
			: formatDurationUs(row.completedTs - row.startedTs);

	if (row.status === "pending") {
		return html`<div class="entry" id="inv-${row.id}" aria-expanded="false">
    ${renderCardSummary(row, duration, false)}
  </div>`;
	}

	const summary = renderCardSummary(row, duration, true);
	const flamegraphUrl = `/dashboard/${row.owner}/${row.repo}/invocations/${row.id}/flamegraph`;
	return html`<details class="entry entry-expandable"
    id="inv-${row.id}"
    hx-get="${flamegraphUrl}"
    hx-trigger="toggle once"
    hx-target="find .flame-slot"
    hx-swap="innerHTML">
    <summary class="entry-summary" aria-label="Expand invocation details">
      ${summary}
    </summary>
    <div class="flame-slot"></div>
  </details>`;
}

function renderInvocationList(invocations: readonly InvocationRow[]) {
	if (invocations.length === 0) {
		return html`<div class="empty-state" data-count="0">No invocations yet</div>`;
	}
	const nowIso = new Date().toISOString();
	const sorted = sortInvocationRows(invocations);
	const count = sorted.length;
	const header = html`<div class="list-header" aria-label="Invocation list summary">
      <span class="list-header-count">${count} invocation${count === 1 ? "" : "s"}</span>
      <span class="entry-sep">·</span>
      <span>pending first, then newest-completed</span>
      <span class="entry-sep">·</span>
      <span>updated ${renderTime(nowIso, "list-header-updated")}</span>
    </div>`;
	return html`<div data-count="${String(count)}">
    ${header}
    ${sorted.map(renderCard)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Top-level page — always a flat list, titled by the active filter
// ---------------------------------------------------------------------------

interface DashboardFilter {
	readonly owner: string;
	readonly repo?: string;
	readonly workflow?: string;
	readonly trigger?: string;
}

interface DashboardPageOptions {
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly rows: readonly InvocationRow[];
	// The active filter, derived from the URL. `undefined` = show all scopes
	// the user has access to.
	readonly filter?: DashboardFilter;
	readonly sidebarTree?: HtmlEscapedString | Promise<HtmlEscapedString>;
}

function renderScopeLabel(filter: DashboardPageOptions["filter"]) {
	if (!filter) {
		return html`<span class="scope-all">All invocations</span>`;
	}
	if (!filter.repo) {
		return html`<a href="/dashboard">All</a>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">${filter.owner}</span>`;
	}
	if (!(filter.workflow && filter.trigger)) {
		return html`<a href="/dashboard">All</a>
      <span class="breadcrumb-sep">/</span>
      <a href="/dashboard/${filter.owner}">${filter.owner}</a>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">${filter.repo}</span>`;
	}
	return html`<a href="/dashboard">All</a>
    <span class="breadcrumb-sep">/</span>
    <a href="/dashboard/${filter.owner}">${filter.owner}</a>
    <span class="breadcrumb-sep">/</span>
    <a href="/dashboard/${filter.owner}/${filter.repo}">${filter.repo}</a>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-current">${filter.workflow} / ${filter.trigger}</span>`;
}

function renderDashboardPage(options: DashboardPageOptions) {
	const { user, email, owners, rows, filter, sidebarTree } = options;
	const head = html`  <script defer src="/static/flamegraph.js"></script>`;
	const content = html`
  <div class="page-header">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      ${renderScopeLabel(filter)}
    </nav>
    <h1>Dashboard</h1>
  </div>

  <div class="list">
    ${renderInvocationList(rows)}
  </div>`;

	return renderLayout(
		{
			title: "Dashboard",
			activePath: "/dashboard",
			user,
			email,
			owners,
			head,
			...(sidebarTree ? { sidebarTree } : {}),
		},
		content,
	);
}

export type { InvocationRow };
export {
	formatDurationUs,
	renderDashboardPage,
	renderInvocationList,
	sortInvocationRows,
};
