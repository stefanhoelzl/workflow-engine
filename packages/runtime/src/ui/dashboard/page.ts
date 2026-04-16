import { html } from "hono/html";
import { renderLayout } from "../layout.js";

const MS_PER_SECOND = 1000;
const SECOND_FRACTION_DIGITS = 2;
const SKELETON_CARD_COUNT = 3;

interface InvocationRow {
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly status: string;
	readonly startedAt: string | Date;
	readonly completedAt: string | Date | null;
}

function formatTimestamp(ts: string | Date): string {
	const d = ts instanceof Date ? ts : new Date(ts);
	return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

function formatDuration(
	startedAt: string | Date,
	completedAt: string | Date | null,
): string {
	if (completedAt === null) {
		return "—";
	}
	const start =
		startedAt instanceof Date
			? startedAt.getTime()
			: Date.parse(String(startedAt));
	const end =
		completedAt instanceof Date
			? completedAt.getTime()
			: Date.parse(String(completedAt));
	if (Number.isNaN(start) || Number.isNaN(end)) {
		return "—";
	}
	const ms = Math.max(0, end - start);
	if (ms < MS_PER_SECOND) {
		return `${ms}ms`;
	}
	return `${(ms / MS_PER_SECOND).toFixed(SECOND_FRACTION_DIGITS)}s`;
}

function renderCard(row: InvocationRow) {
	return html`<div class="entry" id="inv-${row.id}" aria-expanded="false">
    <div class="entry-header">
      <span class="entry-workflow">${row.workflow}</span>
      <span class="entry-trigger">${row.trigger}</span>
      <span class="badge ${row.status}">${row.status}</span>
    </div>
    <div class="entry-meta">
      <span class="entry-started">${formatTimestamp(row.startedAt)}</span>
      <span class="entry-sep">·</span>
      <span class="entry-duration">${formatDuration(row.startedAt, row.completedAt)}</span>
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
