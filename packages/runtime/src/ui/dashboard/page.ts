import { html } from "hono/html";
import { renderLayout } from "../layout.js";

function renderPage(user: string, email: string) {
	const head = html`  <style>
    .stats {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .stat-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .event-type-list { display: flex; flex-direction: column; gap: 2px; }

    .event-type-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      cursor: pointer;
    }

    .event-type-option:hover { background: var(--bg-hover, var(--bg-surface)); }

    .event-type-option input[type="checkbox"] {
      accent-color: var(--accent);
    }

    .entry-type {
      font-weight: 600;
      font-size: 14px;
      font-family: var(--font-mono);
      flex: 1;
    }

    .entry-meta {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--text-muted);
      align-items: center;
    }

    .entry-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .timeline-container {
      border-top: 1px solid var(--border);
      background: var(--bg-surface);
      padding: 24px;
      display: none;
      max-height: 50vh;
      overflow: auto;
    }

    .entry.expanded .timeline-container {
      display: block;
    }

    .timeline-svg { overflow: visible; }

    .node { cursor: pointer; }
    .node .node-circle { transition: r 0.15s ease; }
    .node:hover .node-circle { r: 10; }
    .node .node-label { font-family: var(--font-mono); font-size: 11px; fill: var(--text); }
    .node .node-action { font-family: var(--font-mono); font-size: 10px; fill: var(--text-secondary); font-weight: 600; }
    .edge-line { stroke: var(--border); stroke-width: 2; fill: none; }
  </style>`;

	const bodyAttrs = `x-data="{ tip: null, tipX: 0, tipY: 0, _tipTimer: null, _copied: false }"`;

	const content = html`
  <div class="tooltip"
       x-show="tip"
       x-transition.opacity.duration.150ms
       :style="\`left: \${tipX}px; top: \${tipY}px\`"
       @mouseenter="clearTimeout(_tipTimer)"
       @mouseleave="_tipTimer = setTimeout(() => tip = null, 100)"
       x-cloak>
    <template x-if="tip">
      <div>
        <div class="tooltip-title">
          <span class="dot" :style="\`background: var(--\${tip.color})\`"></span>
          <span x-text="tip.type"></span>
          <span class="badge" :class="tip.state" x-text="tip.state" style="margin-left: auto"></span>
        </div>
        <div class="tooltip-payload"><button class="copy-btn" @click="navigator.clipboard.writeText(tip.event); _copied = true; setTimeout(() => _copied = false, 1500)" :title="_copied ? 'Copied!' : 'Copy JSON'"><svg x-show="!_copied" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg x-show="_copied" x-cloak xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button><span x-text="tip.event"></span></div>
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

  <div class="filters" id="filter-bar"
       x-data="{
         state: '',
         type: '',
         eventTypes: [],
         eventTypeOpen: false,
         load() {
           let params = new URLSearchParams();
           if (this.state) params.set('state', this.state);
           if (this.type) params.set('type', this.type);
           if (this.eventTypes.length) params.set('eventTypes', this.eventTypes.join(','));
           let qs = params.toString();
           htmx.ajax('GET', '/dashboard/list' + (qs ? '?' + qs : ''), {target: '#entry-list', swap: 'innerHTML'});
         },
         toggleEventType(t) {
           let idx = this.eventTypes.indexOf(t);
           if (idx === -1) this.eventTypes.push(t);
           else this.eventTypes.splice(idx, 1);
           this.load();
         }
       }"
       x-init="
         fetch('/dashboard/list?fragment=triggerTypes').then(r => r.text()).then(html => { $refs.triggerFilter.innerHTML = html });
         fetch('/dashboard/list?fragment=eventTypes').then(r => r.text()).then(html => { $refs.eventTypeList.innerHTML = html });
       ">
    <select class="filter-select" x-model="state" @change="load()">
      <option value="">All states</option>
      <option value="pending">Pending</option>
      <option value="done">Done</option>
      <option value="failed">Failed</option>
    </select>
    <select class="filter-select" x-ref="triggerFilter" x-model="type" @change="load()">
      <option value="">All trigger types</option>
    </select>
    <div class="filter-dropdown" style="position:relative">
      <button type="button" class="filter-btn" @click="eventTypeOpen = !eventTypeOpen"
              :class="{ active: eventTypes.length > 0 }">
        <span x-text="eventTypes.length ? eventTypes.length + ' event types' : 'All event types'"></span>
        <span style="margin-left:4px;font-size:10px">&#9662;</span>
      </button>
      <div class="filter-dropdown-menu" x-show="eventTypeOpen" @click.outside="eventTypeOpen = false"
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
			head,
			bodyAttrs,
		},
		content,
	);
}

export { renderPage };
