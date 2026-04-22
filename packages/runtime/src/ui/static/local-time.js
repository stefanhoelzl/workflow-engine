// Post-SSR rewrite of <time datetime=ISO> elements into the viewer's local
// timezone and locale. The ISO string stays in the `datetime` attribute so
// machine-readable consumers keep the original value; only the text content
// is rewritten. Runs on DOMContentLoaded and after every HTMX swap.

(() => {
	const FormatOptions = { dateStyle: "medium", timeStyle: "medium" };

	function rewriteTime(el) {
		const iso = el.getAttribute("datetime");
		if (!iso) {
			return;
		}
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) {
			return;
		}
		el.textContent = date.toLocaleString(undefined, FormatOptions);
	}

	function rewriteAll(root) {
		const scope = root instanceof Element ? root : document;
		for (const el of scope.querySelectorAll("time[datetime]")) {
			rewriteTime(el);
		}
	}

	function clearAriaBusy(root) {
		const scope = root instanceof Element ? root : document;
		for (const el of scope.querySelectorAll('[aria-busy="true"]')) {
			// Only clear aria-busy on containers whose content has been swapped in.
			// The invocation list's aria-busy lives on its HTMX target, so any
			// afterSwap event targeting that container means content is ready.
			el.setAttribute("aria-busy", "false");
		}
	}

	document.addEventListener("DOMContentLoaded", () => {
		rewriteAll(document);
	});

	document.body?.addEventListener("htmx:afterSwap", (event) => {
		const target = event.target;
		rewriteAll(target);
		if (target instanceof Element) {
			// The swap target itself may carry aria-busy.
			if (target.getAttribute("aria-busy") === "true") {
				target.setAttribute("aria-busy", "false");
			}
			clearAriaBusy(target);
		}
	});

	// Fallback if body isn't ready yet.
	document.addEventListener("htmx:afterSwap", (event) => {
		const target = event.target;
		rewriteAll(target);
		if (target instanceof Element) {
			if (target.getAttribute("aria-busy") === "true") {
				target.setAttribute("aria-busy", "false");
			}
			clearAriaBusy(target);
		}
	});
})();
