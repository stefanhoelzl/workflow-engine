// Post-SSR rewrite of <time datetime=ISO> elements into the viewer's local
// timezone and locale. The ISO string stays in the `datetime` attribute so
// machine-readable consumers keep the original value; only the text content
// is rewritten. Runs on DOMContentLoaded and after every HTMX swap.

const formatOptions = { dateStyle: "medium", timeStyle: "medium" };
const relFmt =
	typeof Intl !== "undefined" && Intl.RelativeTimeFormat
		? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
		: null;

const msPerSec = 1000;
const secInMin = 60;
const secInHour = 3600;
const secInDay = 86_400;
const secInWeek = 604_800;
const secInMonth = 2_592_000;
const secInYear = 31_536_000;

function pickRelativeUnit(deltaSec) {
	const abs = Math.abs(deltaSec);
	if (abs < secInMin) {
		return { value: deltaSec, unit: "second" };
	}
	if (abs < secInHour) {
		return { value: deltaSec / secInMin, unit: "minute" };
	}
	if (abs < secInDay) {
		return { value: deltaSec / secInHour, unit: "hour" };
	}
	if (abs < secInWeek) {
		return { value: deltaSec / secInDay, unit: "day" };
	}
	if (abs < secInMonth) {
		return { value: deltaSec / secInWeek, unit: "week" };
	}
	if (abs < secInYear) {
		return { value: deltaSec / secInMonth, unit: "month" };
	}
	return { value: deltaSec / secInYear, unit: "year" };
}

function formatRelative(date) {
	const deltaSec = (date.getTime() - Date.now()) / msPerSec;
	if (!relFmt) {
		return date.toLocaleString(undefined, formatOptions);
	}
	const { value, unit } = pickRelativeUnit(deltaSec);
	return relFmt.format(Math.round(value), unit);
}

function rewriteTime(el) {
	const iso = el.getAttribute("datetime");
	if (!iso) {
		return;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return;
	}
	// Title attribute already carries the ISO string; it stays as-is so
	// hovering reveals the exact wall-clock value. Only the textContent
	// is rewritten — relative for elements opted in via data-relative,
	// localised absolute otherwise.
	const relative = el.getAttribute("data-relative") === "true";
	el.textContent = relative
		? formatRelative(date)
		: date.toLocaleString(undefined, formatOptions);
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

function onHtmxSwap(event) {
	const target = event.target;
	rewriteAll(target);
	if (target instanceof Element) {
		if (target.getAttribute("aria-busy") === "true") {
			target.setAttribute("aria-busy", "false");
		}
		clearAriaBusy(target);
	}
}

document.addEventListener("DOMContentLoaded", () => {
	rewriteAll(document);
});
document.body?.addEventListener("htmx:afterSwap", onHtmxSwap);
// Fallback if body isn't ready yet.
document.addEventListener("htmx:afterSwap", onHtmxSwap);
