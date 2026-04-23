import { html, raw } from "hono/html";
import { renderLayout } from "../layout.js";
import { triggerKindIcon } from "../triggers.js";

const US_PER_MS = 1000;
const US_PER_SECOND = 1_000_000;
const US_PER_MINUTE = 60_000_000;
const DURATION_FRACTION_DIGITS = 1;
const SKELETON_CARD_COUNT = 3;

interface InvocationRow {
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly status: string;
	readonly startedAt: string | Date;
	readonly completedAt: string | Date | null;
	readonly startedTs: number;
	readonly completedTs: number | null;
	// Optional trigger kind ("http" | "cron"). Resolved from the workflow
	// registry at render time. May be undefined if the trigger was unloaded
	// since the invocation was recorded.
	readonly triggerKind?: string;
	// Dispatch provenance parsed from the invocation's trigger.request event's
	// meta.dispatch. Absent for legacy invocations archived before this
	// feature. Only `user.name` is materialized on the list (mail stays in
	// the flamegraph tooltip to keep list rows compact).
	readonly dispatch?: {
		readonly source: "manual" | "trigger";
		readonly user?: { readonly name: string };
	};
}

function toIsoString(ts: string | Date): string {
	const d = ts instanceof Date ? ts : new Date(ts);
	return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

// SSR emits ISO in both the `datetime` attribute (machine-readable, stable)
// and the initial text content (legible fallback for JS-disabled clients).
// `/static/local-time.js` rewrites textContent to the viewer's locale.
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
	// Label stays compact ("manual"); the tooltip surfaces just the user
	// name when present, so hover attributes the fire without re-stating
	// what the chip already shows.
	const tooltip = dispatch.user?.name ?? "";
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
	const flamegraphUrl = `/dashboard/invocations/${row.id}/flamegraph`;
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
	const count = invocations.length;
	const header = html`<div class="list-header" aria-label="Invocation list summary">
      <span class="list-header-count">${count} invocation${count === 1 ? "" : "s"}</span>
      <span class="entry-sep">·</span>
      <span>newest first</span>
      <span class="entry-sep">·</span>
      <span>updated ${renderTime(nowIso, "list-header-updated")}</span>
    </div>`;
	return html`<div data-count="${String(count)}">
    ${header}
    ${invocations.map(renderCard)}
  </div>`;
}

function renderSkeletonCards() {
	const placeholders = Array.from({ length: SKELETON_CARD_COUNT });
	return html`${placeholders.map(
		() => html`<div class="entry skeleton" aria-hidden="true"></div>`,
	)}`;
}

interface DashboardPageOptions {
	readonly user: string;
	readonly email: string;
	readonly tenants: readonly string[];
	readonly activeTenant: string | undefined;
}

function renderDashboardPage(options: DashboardPageOptions) {
	const { user, email, tenants, activeTenant } = options;
	const invocationsUrl = activeTenant
		? `/dashboard/invocations?tenant=${encodeURIComponent(activeTenant)}`
		: "/dashboard/invocations";
	const head = html`  <script defer src="/static/flamegraph.js"></script>`;
	const content = html`
  <div class="page-header">
    <h1>Dashboard</h1>
  </div>

  <div class="list">
    <div id="invocation-list"
         aria-busy="true"
         hx-get="${invocationsUrl}"
         hx-trigger="load"
         hx-swap="innerHTML">
      ${renderSkeletonCards()}
    </div>
  </div>`;

	return renderLayout(
		{
			title: "Dashboard",
			activePath: "/dashboard",
			user,
			email,
			tenants,
			head,
			...(activeTenant === undefined ? {} : { activeTenant }),
		},
		content,
	);
}

export type { InvocationRow };
export { formatDurationUs, renderDashboardPage, renderInvocationList };
