import { html } from "hono/html";
import { renderLayout } from "../layout.js";

const MS_PER_SECOND = 1000;
const SECOND_FRACTION_DIGITS = 2;

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

function renderRow(row: InvocationRow) {
	const statusClass = `status-${row.status}`;
	return html`<tr class="invocation-row">
    <td class="invocation-workflow">${row.workflow}</td>
    <td class="invocation-trigger">${row.trigger}</td>
    <td class="invocation-status"><span class="${statusClass}">${row.status}</span></td>
    <td class="invocation-started">${formatTimestamp(row.startedAt)}</td>
    <td class="invocation-duration">${formatDuration(row.startedAt, row.completedAt)}</td>
  </tr>`;
}

function renderDashboardPage(
	invocations: readonly InvocationRow[],
	user: string,
	email: string,
) {
	const content = html`
  <div class="page-header">
    <h1>Dashboard</h1>
  </div>

  <div class="dashboard-content">
    ${
			invocations.length > 0
				? html`<table class="invocations-table">
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${invocations.map(renderRow)}
        </tbody>
      </table>`
				: html`<div class="empty-state">No invocations yet</div>`
		}
  </div>`;

	return renderLayout(
		{ title: "Dashboard", activePath: "/dashboard", user, email },
		content,
	);
}

export type { InvocationRow };
export { renderDashboardPage };
