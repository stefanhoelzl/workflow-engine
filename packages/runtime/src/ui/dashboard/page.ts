import { html } from "hono/html";
import { renderLayout } from "../layout.js";

function renderPage(user: string, email: string) {
	const bodyAttrs = `x-data="dashboardTooltip"`;

	const content = html`
  <div class="tooltip"
       x-show="tip"
       x-transition.opacity.duration.150ms
       :style="{ left: tipX + 'px', top: tipY + 'px' }"
       @mouseenter="cancelHide()"
       @mouseleave="scheduleHide()"
       x-cloak>
    <template x-if="tip">
      <div>
        <div class="tooltip-title">
          <span class="dot" :style="{ background: tip.background }"></span>
          <span x-text="tip.type"></span>
          <span class="badge" :class="tip.state" x-text="tip.state"></span>
        </div>
        <div class="tooltip-payload"><button class="copy-btn" @click="copyEvent()" :title="_copied ? 'Copied!' : 'Copy JSON'"><svg x-show="!_copied" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg x-show="_copied" x-cloak xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button><span x-text="tip.event"></span></div>
      </div>
    </template>
  </div>

  <div class="page-header">
    <h1>Dashboard</h1>
    <div class="stats" id="header-stats"
         hx-get="/dashboard/list?fragment=stats"
         hx-trigger="load"
         hx-swap="innerHTML">
    </div>
  </div>

  <div class="filters" id="filter-bar" x-data="dashboardFilters">
    <select class="filter-select" x-model="state" @change="load()">
      <option value="">All states</option>
      <option value="pending">Pending</option>
      <option value="done">Done</option>
      <option value="failed">Failed</option>
    </select>
    <select class="filter-select" x-ref="triggerFilter" x-model="type" @change="load()">
      <option value="">All trigger types</option>
    </select>
    <div class="filter-dropdown">
      <button type="button" class="filter-btn" @click="toggleEventTypes()"
              :class="{ active: eventTypes.length > 0 }">
        <span x-text="eventTypes.length ? eventTypes.length + ' event types' : 'All event types'"></span>
        <span class="filter-btn-caret">&#9662;</span>
      </button>
      <div class="filter-dropdown-menu" x-show="eventTypeOpen" @click.outside="closeEventTypes()"
           x-transition.opacity>
        <div x-ref="eventTypeList" class="event-type-list"></div>
      </div>
    </div>
  </div>

  <div class="list">
    <div id="entry-list"
         hx-get="/dashboard/list"
         hx-trigger="load"
         hx-swap="innerHTML">
    </div>
  </div>`;

	return renderLayout(
		{
			title: "Dashboard",
			activePath: "/dashboard",
			user,
			email,
			bodyAttrs,
		},
		content,
	);
}

export { renderPage };
