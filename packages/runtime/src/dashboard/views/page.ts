import { renderLayout } from "../../views/layout.js";

function renderPage(): string {
	const head = `  <style>
    .header {
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(8px);
    }

    .header h1 {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

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

    .filters {
      padding: 12px 24px;
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-surface);
    }

    .filter-btn {
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: var(--font);
      display: flex;
      align-items: center;
    }

    .filter-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .filter-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .filter-select {
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: 13px;
      font-family: var(--font);
      cursor: pointer;
      appearance: none;
      padding-right: 28px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b6f8a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
    }

    .filter-dropdown { position: relative; }

    .filter-dropdown-menu {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 4px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      padding: 8px;
      min-width: 200px;
      max-height: 300px;
      overflow-y: auto;
      z-index: 50;
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

    .list {
      max-width: 960px;
      margin: 0 auto;
      padding: 16px 24px;
    }

    .entry {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 8px;
      overflow: hidden;
      transition: box-shadow 0.15s ease;
    }

    .entry:hover {
      box-shadow: var(--shadow);
    }

    .entry-header {
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      user-select: none;
    }

    .state-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .state-dot.pending {
      background: var(--yellow);
      box-shadow: 0 0 0 3px var(--yellow-border);
      animation: pulse 2s ease-in-out infinite;
    }

    .state-dot.done {
      background: var(--green);
      box-shadow: 0 0 0 3px var(--green-border);
    }

    .state-dot.failed {
      background: var(--red);
      box-shadow: 0 0 0 3px var(--red-border);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
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

    .badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge.pending { background: var(--yellow-bg); color: var(--yellow); border: 1px solid var(--yellow-border); }
    .badge.done { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
    .badge.failed { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border); }

    .chevron {
      color: var(--text-muted);
      transition: transform 0.2s ease;
      font-size: 16px;
    }

    .entry.expanded .chevron {
      transform: rotate(90deg);
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

    .tooltip {
      position: fixed;
      z-index: 1000;
      pointer-events: auto;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      padding: 12px 16px;
      font-size: 12px;
      width: 40vw;
      max-width: 480px;
    }

    .tooltip-title {
      font-weight: 600;
      font-family: var(--font-mono);
      font-size: 13px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tooltip-title .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tooltip-payload {
      position: relative;
      margin-top: 8px;
      padding: 8px;
      padding-right: 32px;
      background: var(--bg-surface);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      white-space: pre;
      max-height: 40vh;
      overflow-y: auto;
    }

    .copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s ease, background 0.15s ease;
    }

    .copy-btn:hover {
      background: var(--bg-elevated);
      color: var(--text);
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
      font-size: 14px;
    }
  </style>`;

	const bodyAttrs = `x-data="{ tip: null, tipX: 0, tipY: 0, _tipTimer: null, _copied: false }"`;

	const content = `
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

  <div class="header">
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
		{ title: "Dashboard", activePath: "/dashboard", head, bodyAttrs },
		content,
	);
}

export { renderPage };
