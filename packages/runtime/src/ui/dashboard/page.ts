import { html } from "hono/html";
import { renderLayout } from "../layout.js";

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
	// Optional trigger kind ("http" for HTTP triggers). Resolved from the
	// workflow registry at render time. May be undefined if the trigger was
	// unloaded since the invocation was recorded.
	readonly triggerKind?: string;
}

// Kind → glyph mapping — shared in concept with the trigger-ui's KIND_ICONS
// map (adding a new kind requires a line in each).
const KIND_ICONS: Record<string, string> = {
	http: "\u{1F310}", // globe
};

function renderKindIcon(kind: string | undefined) {
	if (!kind) {
		return "";
	}
	const glyph = KIND_ICONS[kind] ?? "\u{25CF}";
	return html`<span class="entry-kind-icon" title="${kind}" aria-label="${kind}">${glyph}</span>`;
}

function formatTimestamp(ts: string | Date): string {
	const d = ts instanceof Date ? ts : new Date(ts);
	return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
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

function renderCardSummary(row: InvocationRow, duration: string) {
	return html`<div class="entry-header">
      ${renderKindIcon(row.triggerKind)}
      <span class="entry-workflow">${row.workflow}</span>
      <span class="entry-trigger">${row.trigger}</span>
      <span class="badge ${row.status}">${row.status}</span>
    </div>
    <div class="entry-meta">
      <span class="entry-started">${formatTimestamp(row.startedAt)}</span>
      <span class="entry-sep">·</span>
      <span class="entry-duration">${duration}</span>
    </div>`;
}

function renderCard(row: InvocationRow) {
	const duration =
		row.completedTs === null
			? "—"
			: formatDurationUs(row.completedTs - row.startedTs);
	const summary = renderCardSummary(row, duration);

	if (row.status === "pending") {
		return html`<div class="entry" id="inv-${row.id}" aria-expanded="false">
    ${summary}
  </div>`;
	}

	const flamegraphUrl = `/dashboard/invocations/${row.id}/flamegraph`;
	return html`<details class="entry entry-expandable"
    id="inv-${row.id}"
    hx-get="${flamegraphUrl}"
    hx-trigger="toggle once"
    hx-target="find .flame-slot"
    hx-swap="innerHTML">
    <summary class="entry-summary">
      ${summary}
    </summary>
    <div class="flame-slot"></div>
  </details>`;
}

function renderInvocationList(invocations: readonly InvocationRow[]) {
	if (invocations.length === 0) {
		return html`<div class="empty-state">No invocations yet</div>`;
	}
	return html`${invocations.map(renderCard)}`;
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
