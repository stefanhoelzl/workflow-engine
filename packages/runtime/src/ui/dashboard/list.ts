import type { CorrelationSummary, HeaderStats } from "./queries.js";

const TIME_SLICE_END = 8;
const TIME_PATTERN = /\d{2}:\d{2}:\d{2}/;

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatTime(value: string | Date): string {
	if (value instanceof Date) {
		return (
			value.toISOString().split("T")[1]?.slice(0, TIME_SLICE_END) ??
			value.toISOString()
		);
	}
	const s = String(value);
	const spaceMatch = s.match(TIME_PATTERN);
	if (spaceMatch) {
		return spaceMatch[0];
	}
	return s.split("T")[1]?.slice(0, TIME_SLICE_END) ?? s;
}

function renderEntryRow(item: CorrelationSummary): string {
	const state = item.aggregateState;
	const time = formatTime(item.lastEventAt as string | Date);

	return `<div class="entry" id="entry-${escapeHtml(item.correlationId)}" x-data="{ expanded: false }" :class="{ expanded: expanded }">
  <div class="entry-header" @click="expanded = !expanded">
    <span class="state-dot ${state}"></span>
    <span class="entry-type">${escapeHtml(item.initialEventType)}</span>
    <div class="entry-meta">
      <span class="badge ${state}">${state.toUpperCase()}</span>
      <span>${item.eventCount} events</span>
      <span>${escapeHtml(time)}</span>
    </div>
    <span class="chevron">&#9656;</span>
  </div>
  <div class="timeline-container" x-show="expanded" @click.stop>
    <div hx-get="/dashboard/timeline/${escapeHtml(item.correlationId)}"
         hx-trigger="intersect once"
         hx-swap="innerHTML">
    </div>
  </div>
</div>`;
}

function renderEntryList(
	items: CorrelationSummary[],
	nextCursor: string | null,
	params: URLSearchParams,
): string {
	if (items.length === 0) {
		return `<div class="empty-state">No workflow executions found.</div>`;
	}

	const rows = items.map((item) => renderEntryRow(item)).join("\n");

	if (!nextCursor) {
		return rows;
	}

	const nextParams = new URLSearchParams(params);
	nextParams.set("cursor", nextCursor);

	return `${rows}
<div hx-get="/dashboard/list?${nextParams.toString()}"
     hx-trigger="revealed"
     hx-swap="afterend">
</div>`;
}

function renderHeaderStats(stats: HeaderStats): string {
	return `<div id="header-stats">
<span class="stat"><span class="stat-dot" style="background:var(--yellow)"></span> ${stats.pending} pending</span>
<span class="stat"><span class="stat-dot" style="background:var(--red)"></span> ${stats.failed} failed</span>
<span class="stat"><span class="stat-dot" style="background:var(--green)"></span> ${stats.done} done</span>
</div>`;
}

function renderTypeFilter(types: string[], selected: string): string {
	const options = types.map((t) => {
		const sel = t === selected ? " selected" : "";
		return `<option value="${escapeHtml(t)}"${sel}>${escapeHtml(t)}</option>`;
	});
	return `<option value="">All trigger types</option>\n${options.join("\n")}`;
}

function renderEventTypeCheckboxes(
	types: string[],
	selected: string[],
): string {
	const selectedSet = new Set(selected);
	return types
		.map((t) => {
			const checked = selectedSet.has(t) ? " checked" : "";
			return `<label class="event-type-option">
  <input type="checkbox" value="${escapeHtml(t)}"${checked} @change="toggleEventType('${escapeHtml(t)}')" />
  ${escapeHtml(t)}
</label>`;
		})
		.join("\n");
}

export {
	renderEntryList,
	renderEventTypeCheckboxes,
	renderHeaderStats,
	renderTypeFilter,
};
