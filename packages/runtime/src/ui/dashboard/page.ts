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

function renderCard(row: InvocationRow) {
	const duration =
		row.completedTs === null
			? "—"
			: formatDurationUs(row.completedTs - row.startedTs);
	return html`<div class="entry" id="inv-${row.id}" aria-expanded="false">
    <div class="entry-header">
      <span class="entry-workflow">${row.workflow}</span>
      <span class="entry-trigger">${row.trigger}</span>
      <span class="badge ${row.status}">${row.status}</span>
    </div>
    <div class="entry-meta">
      <span class="entry-started">${formatTimestamp(row.startedAt)}</span>
      <span class="entry-sep">·</span>
      <span class="entry-duration">${duration}</span>
    </div>
  </div>`;
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

function renderDashboardPage(user: string, email: string) {
	const content = html`
  <div class="page-header">
    <h1>Dashboard</h1>
  </div>

  <div class="list">
    <div id="invocation-list"
         hx-get="/dashboard/invocations"
         hx-trigger="load"
         hx-swap="innerHTML">
      ${renderSkeletonCards()}
    </div>
  </div>`;

	return renderLayout(
		{ title: "Dashboard", activePath: "/dashboard", user, email },
		content,
	);
}

export type { InvocationRow };
export { renderDashboardPage, renderInvocationList };
