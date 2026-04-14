/* global Alpine */

const TOOLTIP_HORIZONTAL_OFFSET = 140;
const TOOLTIP_VERTICAL_GAP = 8;
const TOOLTIP_HIDE_DELAY_MS = 100;
const COPIED_INDICATOR_MS = 1500;

function registerTooltip() {
	Alpine.data("dashboardTooltip", () => ({
		tip: null,
		tipX: 0,
		tipY: 0,
		_tipTimer: null,
		_copied: false,

		showTip(el) {
			clearTimeout(this._tipTimer);
			const rect = el.getBoundingClientRect();
			this.tip = {
				type: el.dataset.type,
				state: el.dataset.state,
				event: el.dataset.event,
				background: `var(--${el.dataset.color})`,
			};
			this.tipX = rect.left + rect.width / 2 - TOOLTIP_HORIZONTAL_OFFSET;
			this.tipY = rect.bottom + TOOLTIP_VERTICAL_GAP;
		},

		scheduleHide() {
			this._tipTimer = setTimeout(() => {
				this.tip = null;
			}, TOOLTIP_HIDE_DELAY_MS);
		},

		cancelHide() {
			clearTimeout(this._tipTimer);
		},

		copyEvent() {
			if (!this.tip) {
				return;
			}
			navigator.clipboard.writeText(this.tip.event);
			this._copied = true;
			setTimeout(() => {
				this._copied = false;
			}, COPIED_INDICATOR_MS);
		},
	}));
}

function registerFilters() {
	Alpine.data("dashboardFilters", () => ({
		state: "",
		type: "",
		eventTypes: [],
		eventTypeOpen: false,

		init() {
			fetch("/dashboard/list?fragment=triggerTypes")
				.then((r) => r.text())
				.then((html) => {
					this.$refs.triggerFilter.innerHTML = html;
				});
			// biome-ignore lint/security/noSecrets: static dashboard list fragment URL
			fetch("/dashboard/list?fragment=eventTypes")
				.then((r) => r.text())
				.then((html) => {
					this.$refs.eventTypeList.innerHTML = html;
				});
		},

		load() {
			const params = new URLSearchParams();
			if (this.state) {
				params.set("state", this.state);
			}
			if (this.type) {
				params.set("type", this.type);
			}
			if (this.eventTypes.length > 0) {
				params.set("eventTypes", this.eventTypes.join(","));
			}
			const qs = params.toString();
			window.htmx.ajax("GET", `/dashboard/list${qs ? `?${qs}` : ""}`, {
				target: "#entry-list",
				swap: "innerHTML",
			});
		},

		toggleEventType(t) {
			const idx = this.eventTypes.indexOf(t);
			if (idx === -1) {
				this.eventTypes.push(t);
			} else {
				this.eventTypes.splice(idx, 1);
			}
			this.load();
		},

		toggleEventTypes() {
			this.eventTypeOpen = !this.eventTypeOpen;
		},

		closeEventTypes() {
			this.eventTypeOpen = false;
		},
	}));
}

function registerExpander() {
	Alpine.data("listItemExpander", () => ({
		expanded: false,

		toggle() {
			this.expanded = !this.expanded;
		},
	}));
}

document.addEventListener("alpine:init", () => {
	registerTooltip();
	registerFilters();
	registerExpander();
});
