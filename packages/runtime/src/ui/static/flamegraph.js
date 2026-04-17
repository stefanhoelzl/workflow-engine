// Flamegraph interactions: timer-id cross-highlight on hover, and bar/marker
// click → shared result-dialog (window.showResultBlocks, defined in
// trigger-forms.js).
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
		const all = svg.querySelectorAll("rect, path, line, circle");
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
			const ok = !(
				res &&
				typeof res.kind === "string" &&
				res.kind.endsWith(".error")
			);
			window.showResultBlocks(blocks, ok);
			return;
		}

		if (seqAttr) {
			const e = findEventBySeq(events, seqAttr);
			if (!e) {
				return;
			}
			const label = e.kind || "Event";
			window.showResultBlocks([{ label, payload: e }], true);
		}
	});
})();
