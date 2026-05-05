// Flamegraph interactions:
//   - timer-id cross-highlight on hover
//   - bar/marker click → shared result-dialog (window.showResultBlocks,
//     defined in trigger-forms.js)
//   - ctrl+wheel inside a flame-container → horizontal zoom of the inner
//     canvas (width grows; container's overflow-x scrollbar handles pan).
//     ctrl+0 (with the flamegraph hovered) resets to 100%.
//
// Listeners are delegated on `document` so they keep working across HTMX
// fragment swaps without rebinding.

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: IIFE hosts three delegated listeners (mouseover/mouseout/click) + their shared helpers — kept in one closure so the helpers stay private to the module without polluting window.
(() => {
	const TimerIdAttr = "data-timer-id";
	const EventPairAttr = "data-event-pair";
	const EventSeqAttr = "data-event-seq";
	const TidHit = "tid-hit";
	const TidDim = "tid-dim";
	const TimerIdSelector = `[${TimerIdAttr}]`;
	const ClickSelector = `[${EventPairAttr}], [${EventSeqAttr}]`;
	const HighlightSelector = `.${TidHit}, .${TidDim}`;

	function closestFlamegraphSvg(node) {
		let current = node;
		while (current && current.nodeType === 1) {
			if (
				current.tagName &&
				current.tagName.toLowerCase() === "svg" &&
				current.classList?.contains("flame-graph")
			) {
				return current;
			}
			current = current.parentNode;
		}
		return null;
	}

	function closestFragment(node) {
		let current = node;
		while (current && current.nodeType === 1) {
			if (current.classList?.contains("flame-fragment")) {
				return current;
			}
			current = current.parentNode;
		}
		return null;
	}

	function parseEventsJson(fragment) {
		if (!fragment) {
			return null;
		}
		const script = fragment.querySelector("script.flame-events");
		if (!script) {
			return null;
		}
		try {
			return JSON.parse(script.textContent);
		} catch {
			return null;
		}
	}

	function applyHighlight(svg, tid) {
		// Marker wrappers are <g> elements (so data-timer-id sits on the g,
		// not on the visible <use> beneath); bar rects + connector paths
		// keep timer-id on the leaf shape.
		const all = svg.querySelectorAll("rect, path, line, circle, g");
		for (const el of all) {
			const elTid = el.getAttribute(TimerIdAttr);
			if (elTid === tid) {
				el.classList.add(TidHit);
			} else {
				el.classList.add(TidDim);
			}
		}
	}

	function clearHighlight(svg) {
		for (const el of svg.querySelectorAll(HighlightSelector)) {
			el.classList.remove(TidHit);
			el.classList.remove(TidDim);
		}
	}

	function findEventBySeq(events, seq) {
		const s = Number(seq);
		for (const e of events) {
			if (Number(e.seq) === s) {
				return e;
			}
		}
		return null;
	}

	document.addEventListener("mouseover", (ev) => {
		const svg = closestFlamegraphSvg(ev.target);
		if (!svg) {
			return;
		}
		const hit = ev.target.closest(TimerIdSelector);
		if (!hit) {
			return;
		}
		const tid = hit.getAttribute(TimerIdAttr);
		applyHighlight(svg, tid);
	});

	document.addEventListener("mouseout", (ev) => {
		const svg = closestFlamegraphSvg(ev.target);
		if (!svg) {
			return;
		}
		// Ignore moves within the same timer family to avoid flicker.
		if (
			ev.relatedTarget &&
			svg.contains(ev.relatedTarget) &&
			ev.relatedTarget.closest(TimerIdSelector)
		) {
			return;
		}
		clearHighlight(svg);
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: click-handler has two orthogonal branches (paired bar → two blocks, single marker → one block) each with short-circuit guards — splitting adds callsite plumbing without simplifying the decision tree.
	document.addEventListener("click", (ev) => {
		const svg = closestFlamegraphSvg(ev.target);
		if (!svg) {
			return;
		}
		const hit = ev.target.closest(ClickSelector);
		if (!hit) {
			return;
		}
		if (typeof window.showResultBlocks !== "function") {
			return;
		}
		const fragment = closestFragment(svg);
		const events = parseEventsJson(fragment);
		if (!events) {
			return;
		}

		const pairAttr = hit.getAttribute(EventPairAttr);
		const seqAttr = hit.getAttribute(EventSeqAttr);

		// showResultBlocks's second arg is an HTTP-style status code (number
		// or null), not a boolean. The dialog's pickOutcome() classifies
		// 2xx → green Success, 4xx → amber Failed, 5xx/null → red Error.
		// Synthesise: error events → 500 (red Error), everything else → 200
		// (green Success).
		const StatusOk = 200;
		const StatusError = 500;
		const isErrorEvent = (e) =>
			e && typeof e.kind === "string" && e.kind.endsWith(".error");

		if (pairAttr) {
			const [reqSeqStr, resSeqStr] = pairAttr.split("-");
			const req = findEventBySeq(events, reqSeqStr);
			const res = resSeqStr ? findEventBySeq(events, resSeqStr) : null;
			const blocks = [];
			if (req) {
				blocks.push({ label: "Request", payload: req });
			}
			if (res) {
				blocks.push({ label: "Response", payload: res });
			}
			if (blocks.length === 0) {
				return;
			}
			const status = isErrorEvent(res) ? StatusError : StatusOk;
			window.showResultBlocks(blocks, status);
			return;
		}

		if (seqAttr) {
			const e = findEventBySeq(events, seqAttr);
			if (!e) {
				return;
			}
			const label = e.kind || "Event";
			const status = isErrorEvent(e) ? StatusError : StatusOk;
			window.showResultBlocks([{ label, payload: e }], status);
		}
	});

	// --- Zoom -------------------------------------------------------------
	// Continuous exponential zoom. Each wheel-delta unit scales by
	// exp(deltaY * ZoomSpeed) so trackpads (deltaY ≈ 10/notch) and mouse
	// wheels (deltaY ≈ 100/notch) both feel smooth — the latter step is
	// ~10× larger but covers ~10× more zoom factor per notch. Clamped to
	// [100%, 1,000,000%]. The cap is the practical Chromium limit for an
	// SVG element width (1600 px × 1e6 ≈ 1.6e9 px, near layout-integer
	// overflow).
	const ZoomBase = 100;
	const ZoomMax = 1_000_000;
	// Per-input-device zoom-speed coefficients.
	//   - DOM_DELTA_PIXEL (trackpad, deltaY ≈ ±5 to ±50 per pulse, often
	//     dozens of pulses per gesture): slow, otherwise momentum scrolling
	//     blasts the zoom across orders of magnitude in a single swipe.
	//   - DOM_DELTA_LINE (mouse wheel, deltaY ≈ ±3 per notch in line mode
	//     or ±100 in pixel mode depending on browser): faster per event
	//     since notches are discrete.
	// Each event's ratio is also clamped to ±10% so a single accidental
	// fast pulse cannot leap multiple zoom levels.
	const ZoomSpeedTrackpad = 0.0006;
	const ZoomSpeedWheel = 0.0015;
	const ZoomRatioMin = 0.97;
	const ZoomRatioMax = 1.031;
	const ZoomAttr = "data-flame-zoom";
	const CanvasSelector = ".flame-canvas";
	const ContainerSelector = ".flame-container";

	function closestContainer(node) {
		let current = node;
		while (current && current.nodeType === 1) {
			if (current.classList?.contains("flame-container")) {
				return current;
			}
			current = current.parentNode;
		}
		return null;
	}

	function currentZoom(container) {
		const raw = container.getAttribute(ZoomAttr);
		const n = raw ? Number(raw) : ZoomBase;
		return Number.isFinite(n) && n > 0 ? n : ZoomBase;
	}

	function applyZoom(container, zoom) {
		const canvas = container.querySelector(CanvasSelector);
		if (!canvas) {
			return;
		}
		canvas.style.width = `${zoom}%`;
		container.setAttribute(ZoomAttr, String(zoom));
		scheduleRulerUpdate(container);
	}

	// Coalesce ruler + duration-label refreshes — a fast trackpad fires
	// dozens of wheel events per second; rebuilding labels (DOM mutations
	// + getBoundingClientRect layout flush) on every event drops frames.
	// Schedule one update per animation frame instead.
	const _rulerPending = new WeakSet();
	function scheduleRulerUpdate(container) {
		if (_rulerPending.has(container)) {
			return;
		}
		_rulerPending.add(container);
		requestAnimationFrame(() => {
			_rulerPending.delete(container);
			updateRuler(container);
			updateBarLabels(container);
			updateMarkerClusters(container);
		});
	}

	// Cluster leaf markers that fall within icon-width of each other in
	// the rendered canvas. The single representative shows an "Nx" badge
	// next to its icon and a multi-line tooltip listing each member's
	// title. As the user zooms in, the same ts gap covers more pixels so
	// clusters break apart and individual icons re-appear.
	const MarkerSelector = ".flame-marker";
	const ClusterGapPx = 18; // 16-px icon + 2-px breathing room
	// Once a cluster is open, subsequent markers within this many pixels
	// of the last member are absorbed too — covers the cluster's badge
	// width (~16 px for "12×") so the next marker's icon doesn't land on
	// top of the badge text.
	const ClusterExtendGapPx = 36;
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: marker clustering is one logical pass — group-by-lane, sort, walk groups, decide cluster vs singleton — and inlining keeps the per-marker shared-state (head px, last px, gap thresholds) on one stack frame.
	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same — single sequential pipeline, splitting just shuffles bytes.
	function updateMarkerClusters(container) {
		const canvas = container.querySelector(CanvasSelector);
		const ruler = canvas?.querySelector(RulerSelector);
		const totalTs = Number(ruler?.dataset.totalTs ?? 0);
		if (!(canvas && totalTs)) {
			return;
		}
		const canvasW = canvas.getBoundingClientRect().width;
		const markers = container.querySelectorAll(MarkerSelector);
		// Reset every marker first — restores any previously-replaced
		// title back to the original event description and removes any
		// stale badge. Without this, an already-clustered representative
		// would feed its multi-line "Nx events:\n…" title into the next
		// cluster's title-composition step, producing the recursively
		// nested garbage seen in the bug.
		for (const m of markers) {
			restoreMarker(m);
		}
		// Group by lane (data-marker-row-y) so a main-lane marker doesn't
		// cluster with a track-lane marker that happens to share x.
		const byLane = new Map();
		for (const m of markers) {
			const y = m.getAttribute("data-marker-row-y") ?? "0";
			if (!byLane.has(y)) {
				byLane.set(y, []);
			}
			byLane.get(y).push(m);
		}
		for (const lane of byLane.values()) {
			// Sort lane by pixel x (= ts). data-marker-ts comes from SSR.
			lane.sort(
				(a, b) => Number(a.dataset.markerTs) - Number(b.dataset.markerTs),
			);
			let i = 0;
			while (i < lane.length) {
				const head = lane[i];
				const headPx = (Number(head.dataset.markerTs) / totalTs) * canvasW;
				let lastPx = headPx;
				let j = i + 1;
				while (j < lane.length) {
					const candPx = (Number(lane[j].dataset.markerTs) / totalTs) * canvasW;
					// While building a cluster (≥ 2 members), the next
					// marker must be ≥ ClusterExtendGapPx away from the
					// REP (head) — not just the last member — because the
					// badge sits to the right of the rep's icon. If we
					// compared against `lastPx` instead, a chain of
					// markers spaced 18 px apart would grow indefinitely
					// and the badge could overlap markers that pretended
					// to be outside the cluster.
					const gap = j - i >= 2 ? ClusterExtendGapPx : ClusterGapPx;
					const ref = j - i >= 2 ? headPx : lastPx;
					if (candPx - ref < gap) {
						lastPx = candPx;
						j++;
					} else {
						break;
					}
				}
				const groupSize = j - i;
				if (groupSize > 1) {
					applyCluster(head, lane.slice(i, j), totalTs, canvasW);
				}
				// Singleton case is already handled by the upfront
				// restoreMarker pass; nothing to do.
				i = j;
			}
		}
	}

	function restoreMarker(m) {
		m.style.display = "";
		// Re-show the icon if a previous cluster pass hid it.
		const icon = m.querySelector(":scope > use.flame-marker-icon");
		if (icon) {
			icon.style.display = "";
		}
		// Remove any badge / multi-line tooltip from a previous cluster.
		const badge = m.querySelector(".flame-marker-badge");
		if (badge) {
			badge.remove();
		}
		const original = m.dataset.originalTitle;
		if (original !== undefined) {
			const title = m.querySelector(":scope > title");
			if (title) {
				title.textContent = original;
			}
			delete m.dataset.originalTitle;
		}
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-cluster collapse — hide siblings, compose multi-line title, place badge — kept inline so the per-rep state (icon ref, title backup, badge node) lives on one frame.
	function applyCluster(rep, members, totalTs, canvasW) {
		// Collapse: hide every member except the representative, and
		// stamp the rep with an Nx badge + a multi-line tooltip.
		for (let k = 1; k < members.length; k++) {
			members[k].style.display = "none";
			const innerBadge = members[k].querySelector(".flame-marker-badge");
			if (innerBadge) {
				innerBadge.remove();
			}
		}
		rep.style.display = "";
		// Hide the rep's visible icon — when ≥ 2 events collapse, only the
		// "N×" badge should show. The icon would just look like a single
		// marker that happens to be next to a number.
		const icon = rep.querySelector(":scope > use.flame-marker-icon");
		if (icon) {
			icon.style.display = "none";
		}
		const title = rep.querySelector(":scope > title");
		if (title) {
			if (rep.dataset.originalTitle === undefined) {
				rep.dataset.originalTitle = title.textContent ?? "";
			}
			const lines = members.map(
				(m) => m.querySelector(":scope > title")?.textContent ?? "",
			);
			title.textContent = `${members.length}× events:\n${lines.join("\n")}`;
		}
		// Badge: a small <text> showing the count, placed just to the
		// right of the icon. SVG `x` attribute requires absolute pixel
		// values (no CSS calc()); compute from data-marker-ts so the badge
		// stays attached as the canvas zooms/scrolls.
		let badge = rep.querySelector(".flame-marker-badge");
		const ns = "http://www.w3.org/2000/svg";
		if (!badge) {
			badge = document.createElementNS(ns, "text");
			badge.setAttribute("class", "flame-marker-badge");
			badge.setAttribute("pointer-events", "none");
			rep.appendChild(badge);
		}
		const iconLeftPx = (Number(rep.dataset.markerTs) / totalTs) * canvasW;
		const iconY = Number(rep.getAttribute("data-marker-row-y") ?? "0");
		// The icon is hidden, so place the badge AT the icon's left edge
		// (text-anchor="start"), vertically centred on the row.
		// Icon is 14 px tall; badge baseline sits at icon-mid + a 4-px
		// optical adjust so capital glyphs centre visually.
		const IconHalfHeightPx = 7;
		const BadgeBaselineNudgePx = 4;
		badge.setAttribute("x", String(iconLeftPx));
		badge.setAttribute(
			"y",
			String(iconY + IconHalfHeightPx + BadgeBaselineNudgePx),
		);
		badge.textContent = `${members.length}×`;
	}

	// Hide the bar's right-aligned duration label when the bar is too
	// narrow in actual rendered pixels to fit name + duration without
	// overlap. The SSR check (bar's % of canvas) was zoom-invariant —
	// a 5%-wide bar stays 5% at every zoom level — so the label was
	// either always-on or always-off regardless of pixel width.
	// Roughly: "fetch GET https://..." short-form name (~6 chars) at fs-xs
	// ≈ 50 px + "1.0 ms" duration (~6 chars) ≈ 50 px + 24 px icon = 124 px
	// minimum to fit both without overlap.
	const MinWidthForDurationPx = 130;
	function updateBarLabels(container) {
		const bars = container.querySelectorAll("rect.flame-bar");
		for (const bar of bars) {
			const widthPx = bar.getBoundingClientRect().width;
			// The duration label is the next-to-last <text> inside the bar's
			// clip-path <g>; query it via the kind class to avoid coupling
			// to DOM order.
			const seq = bar.getAttribute("data-event-pair")?.split("-")[0];
			if (!seq) {
				continue;
			}
			const dim = container.querySelector(
				`g[clip-path="url(#bc-${seq})"] text.bar-label-dim`,
			);
			if (!dim) {
				continue;
			}
			dim.style.display = widthPx < MinWidthForDurationPx ? "none" : "";
		}
	}

	// Public-on-window so test harnesses (Playwright screenshot script)
	// can drive zoom without simulating wheel events. Real users always go
	// through handleZoomWheel.
	window.__flameApplyZoom = applyZoom;

	// --- Adaptive ruler ---------------------------------------------------
	// Recomputes ruler tick labels based on the visible time range. Called
	// on initial load, every zoom step, and every scroll event.
	const RulerSelector = ".flame-ruler";
	const TargetTickCount = 8;
	// "Nice" step sizes covering ns → seconds (in microseconds since
	// totalDurationTs is in µs per the InvocationEvent timestamp scale).
	const NiceSteps = (() => {
		const out = [];
		// biome-ignore lint/style/noMagicNumbers: powers-of-10 exponents covering ns → seconds.
		const exponents = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];
		const Two = 2;
		const Five = 5;
		const Base10 = 10;
		for (const exp of exponents) {
			const base = Base10 ** exp;
			out.push(base, Two * base, Five * base);
		}
		return out;
	})();

	function pickNiceStep(target) {
		for (const s of NiceSteps) {
			if (s >= target) {
				return s;
			}
		}
		return NiceSteps.at(-1);
	}

	const UsPerMs = 1000;
	const UsPerSecond = 1_000_000;
	const FractionDigitsTwo = 2;
	const FractionDigitsOne = 1;
	const FractionDigitsZero = 0;
	const TenThreshold = 10;
	const HundredThreshold = 100;

	function fractionDigitsFor(value) {
		if (value < TenThreshold) {
			return FractionDigitsTwo;
		}
		if (value < HundredThreshold) {
			return FractionDigitsOne;
		}
		return FractionDigitsZero;
	}

	function formatDurationUs(usFloat) {
		const us = Math.round(usFloat);
		if (us === 0) {
			return "0 µs";
		}
		if (Math.abs(us) < UsPerMs) {
			return `${us} µs`;
		}
		const ms = us / UsPerMs;
		if (Math.abs(us) < UsPerSecond) {
			return `${ms.toFixed(fractionDigitsFor(ms))} ms`;
		}
		const s = us / UsPerSecond;
		return `${s.toFixed(fractionDigitsFor(s))} s`;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ruler refresh is one logical pass — read visible-range, pick step, walk ticks, anchor edge labels — and threading the local geometry vars (canvasW, scrollLeft, totalTs, ratios) through helpers would just shuffle bytes around.
	function updateRuler(container) {
		const canvas = container.querySelector(CanvasSelector);
		const ruler = canvas?.querySelector(RulerSelector);
		if (!(ruler && canvas)) {
			return;
		}
		const totalTs = Number(ruler.dataset.totalTs ?? 0);
		if (!totalTs) {
			return;
		}
		const canvasWidthPx = canvas.getBoundingClientRect().width;
		const containerWidthPx = container.getBoundingClientRect().width;
		const scrollLeft = container.scrollLeft;
		const visibleStartTs = (scrollLeft / canvasWidthPx) * totalTs;
		const visibleEndTs =
			((scrollLeft + containerWidthPx) / canvasWidthPx) * totalTs;
		const visibleTs = visibleEndTs - visibleStartTs;
		if (visibleTs <= 0) {
			return;
		}
		const step = pickNiceStep(visibleTs / TargetTickCount);
		const firstTick = Math.ceil(visibleStartTs / step) * step;
		const ns = "http://www.w3.org/2000/svg";
		// Drop existing labels (keep the baseline tick line at index 0).
		const existing = ruler.querySelectorAll(".flame-ruler-label");
		for (const el of existing) {
			el.remove();
		}
		// Render a label at every nice tick whose pixel position lies in
		// [scrollLeft, scrollLeft+containerWidth]. Labels live in the
		// canvas's user space (pixels), so position via x="<px>".
		for (let t = firstTick; t <= visibleEndTs + step / 2; t += step) {
			const xPx = (t / totalTs) * canvasWidthPx;
			// Anchor edge labels to the visible-window edge so they don't
			// half-clip off the left or right side of the container.
			let anchor = "middle";
			const distFromLeftPx = xPx - scrollLeft;
			const distFromRightPx = scrollLeft + containerWidthPx - xPx;
			const EdgePadPx = 30;
			if (distFromLeftPx < EdgePadPx) {
				anchor = "start";
			} else if (distFromRightPx < EdgePadPx) {
				anchor = "end";
			}
			const text = document.createElementNS(ns, "text");
			text.setAttribute("class", "flame-ruler-label");
			text.setAttribute("x", String(xPx));
			text.setAttribute("y", "12");
			text.setAttribute("text-anchor", anchor);
			text.textContent = formatDurationUs(t);
			ruler.appendChild(text);
		}
	}

	// Initial render + scroll updates for every flame-container in the DOM.
	function initAllRulers() {
		for (const c of document.querySelectorAll(ContainerSelector)) {
			if (c.dataset.flameRulerInit === "1") {
				continue;
			}
			c.dataset.flameRulerInit = "1";
			// Defer initial measurement to the next animation frame —
			// DOMContentLoaded fires before SVG layout completes, so a
			// synchronous getBoundingClientRect() here returns 0 and every
			// bar/marker thinks it's hidden.
			requestAnimationFrame(() => {
				updateRuler(c);
				updateBarLabels(c);
				updateMarkerClusters(c);
			});
			c.addEventListener("scroll", () => scheduleRulerUpdate(c), {
				passive: true,
			});
		}
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initAllRulers);
	} else {
		initAllRulers();
	}
	// Re-init after htmx fragment swaps add new flamegraphs.
	document.addEventListener("htmx:afterSwap", initAllRulers);
	// And on window resize (container width changes alter visible range).
	window.addEventListener("resize", () => {
		for (const c of document.querySelectorAll(ContainerSelector)) {
			updateRuler(c);
		}
	});

	function clampZoom(z) {
		if (z < ZoomBase) {
			return ZoomBase;
		}
		if (z > ZoomMax) {
			return ZoomMax;
		}
		return z;
	}

	// Latched cursor-anchor for a zoom gesture. Latching the timeline ts
	// under the cursor on the FIRST wheel event of a gesture (and reusing
	// it on every subsequent event in the burst) eliminates the cumulative
	// scrollLeft-rounding drift that re-deriving the anchor each event
	// produced. The browser stores scrollLeft as an integer pixel, so
	// computing `cursor_ts = (scrollLeft + cursorX) / canvasW * totalTs`
	// each event picked up a fresh ±0.5 px rounding error per step — over
	// a 10-event zoom burst at 148× the cursor would walk ~2 px off the
	// hovered icon. The gesture expires after 250 ms of inactivity.
	const GestureIdleMs = 250;
	let _zoomGesture = null;

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: wheel handler — captures gesture, latches anchor ts, applies clamped exponential zoom, re-pins scroll on cursor; inlined so the per-event geometry vars stay on one frame.
	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same.
	function handleZoomWheel(ev) {
		if (!(ev.ctrlKey || ev.metaKey)) {
			return;
		}
		const container = closestContainer(ev.target);
		if (!container) {
			return;
		}
		ev.preventDefault();
		const canvas = container.querySelector(CanvasSelector);
		if (!canvas) {
			return;
		}
		const rect = container.getBoundingClientRect();
		const cursorViewportX = ev.clientX - rect.left;
		const ruler = canvas.querySelector(RulerSelector);
		const totalTs = Number(ruler?.dataset.totalTs ?? 0);
		const now = performance.now();

		// Open a new gesture (or reuse the active one) and capture the ts
		// under the cursor at the moment the gesture began.
		if (
			_zoomGesture === null ||
			_zoomGesture.container !== container ||
			now - _zoomGesture.lastEventT > GestureIdleMs
		) {
			const canvasW = canvas.getBoundingClientRect().width;
			const anchorTs = totalTs
				? ((container.scrollLeft + cursorViewportX) / canvasW) * totalTs
				: 0;
			_zoomGesture = {
				container,
				anchorTs,
				totalTs,
				lastEventT: now,
			};
		}
		_zoomGesture.lastEventT = now;

		const before = currentZoom(container);
		// Negative deltaY = zoom in (scroll up). Exponential scaling makes
		// every notch feel proportional regardless of current zoom level
		// — going 100→200 takes the same number of notches as 100k→200k.
		// Trackpad deltas are smooth/many; mouse wheel deltas are sparse/
		// chunky. Speed-coefficient + per-event ratio clamp together keep
		// either device from leaping zoom levels in one event.
		const speed =
			ev.deltaMode === WheelEvent.DOM_DELTA_PIXEL
				? ZoomSpeedTrackpad
				: ZoomSpeedWheel;
		let ratio = Math.exp(-ev.deltaY * speed);
		if (ratio < ZoomRatioMin) {
			ratio = ZoomRatioMin;
		} else if (ratio > ZoomRatioMax) {
			ratio = ZoomRatioMax;
		}
		const after = clampZoom(before * ratio);
		if (after === before) {
			return;
		}
		applyZoom(container, after);
		// Re-pin the latched anchor under the cursor's viewport position.
		const newCanvasW = canvas.getBoundingClientRect().width;
		if (_zoomGesture.totalTs > 0) {
			container.scrollLeft =
				(_zoomGesture.anchorTs / _zoomGesture.totalTs) * newCanvasW -
				cursorViewportX;
		}
	}

	document.addEventListener("wheel", handleZoomWheel, { passive: false });

	document.addEventListener("keydown", (ev) => {
		if (!(ev.ctrlKey || ev.metaKey) || ev.key !== "0") {
			return;
		}
		const hovered = document.querySelector(`${ContainerSelector}:hover`);
		if (!hovered) {
			return;
		}
		ev.preventDefault();
		applyZoom(hovered, ZoomBase);
		hovered.scrollLeft = 0;
	});
})();
