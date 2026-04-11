import { html } from "hono/html";
import type { CorrelationSummary, HeaderStats } from "./queries.js";

const TIME_SLICE_END = 8;
const TIME_PATTERN = /\d{2}:\d{2}:\d{2}/;

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

function renderEntryRow(item: CorrelationSummary) {
	const state = item.aggregateState;
	const time = formatTime(item.lastEventAt as string | Date);

	return html`<div class="entry" id="entry-${item.correlationId}" x-data="{ expanded: false }" :class="{ expanded: expanded }">
  <div class="entry-header" @click="expanded = !expanded">
    <span class="state-dot ${state}"></span>
    <span class="entry-type">${item.initialEventType}</span>
    <div class="entry-meta">
      <span class="badge ${state}">${state.toUpperCase()}</span>
      <span>${item.eventCount} events</span>
      <span>${time}</span>
    </div>
    <span class="chevron">&#9656;</span>
  </div>
  <div class="timeline-container" x-show="expanded" @click.stop>
    <div hx-get="/dashboard/timeline/${item.correlationId}"
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
) {
	if (items.length === 0) {
		return html`<div class="empty-state">No workflow executions found.</div>`;
	}

	if (!nextCursor) {
		return html`${items.map(renderEntryRow)}`;
	}

	const nextParams = new URLSearchParams(params);
	nextParams.set("cursor", nextCursor);

	return html`${items.map(renderEntryRow)}
<div hx-get="/dashboard/list?${nextParams.toString()}"
     hx-trigger="revealed"
     hx-swap="afterend">
</div>`;
}

function renderHeaderStats(stats: HeaderStats) {
	return html`<div id="header-stats">
<span class="stat"><span class="stat-dot" style="background:var(--yellow)"></span> ${stats.pending} pending</span>
<span class="stat"><span class="stat-dot" style="background:var(--red)"></span> ${stats.failed} failed</span>
<span class="stat"><span class="stat-dot" style="background:var(--green)"></span> ${stats.done} done</span>
</div>`;
}

function renderTypeFilter(types: string[], selected: string) {
	return html`<option value="">All trigger types</option>
${types.map((t) => html`<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`)}`;
}

function renderEventTypeCheckboxes(types: string[], selected: string[]) {
	const selectedSet = new Set(selected);
	return html`${types.map(
		(t) =>
			html`<label class="event-type-option">
  <input type="checkbox" value="${t}"${selectedSet.has(t) ? " checked" : ""} @change="toggleEventType('${t}')" />
  ${t}
</label>`,
	)}`;
}

export {
	renderEntryList,
	renderEventTypeCheckboxes,
	renderHeaderStats,
	renderTypeFilter,
};
