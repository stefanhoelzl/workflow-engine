import type { InvocationEvent } from "@workflow-engine/core";
import { raw } from "hono/html";
import {
	flameIconSprite,
	iconForBar,
	iconForMarker,
	shortLabelFor,
} from "./flame-icons.js";
import { formatDurationUs } from "./page.js";

// Chrome (legend, header, error fragment, top-level wrapper) is JSX. SVG body
// is machine-generated content built via string concatenation in
// `buildSvgPieces` / `renderRuler` and bridged into the JSX tree via
// `{raw(svg)}` / `{raw(ruler)}`. Two-natures rationale: SVG body is hundreds
// of computed-coordinate elements per render — readability win from JSX is
// zero, output bytes change cost is real (existing flamegraph.test.ts
// assertions depend on byte shape).

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT_PX = 22;
const BAR_HEIGHT_PX = 18;
const BAR_Y_OFFSET_PX = 2;
const TRACK_DIVIDER_GAP_PX = 12;
const TRACK_LABEL_HEIGHT_PX = 14;
// Icon and marker glyph dimensions in CSS pixels. The flame-graph SVG
// renders without a viewBox so user units = device pixels; this keeps
// icons and text glyphs from stretching when the canvas is widened by
// ctrl+wheel zoom.
const ICON_SIZE_PX = 14;
const MARKER_WIDTH_PX = 16;
const RULER_HEIGHT_PX = 18;
const PERCENT_MULTIPLIER = 100;
const PERCENT_FRACTION_DIGITS = 4;
const HALF = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Location = "main" | "track";
type BarKind = "trigger" | "action" | "rest";

interface LaidOutBar {
	readonly kind: BarKind;
	readonly name: string;
	readonly requestSeq: number;
	readonly terminalSeq: number | null;
	readonly startTs: number;
	readonly endTs: number;
	readonly row: number;
	readonly location: Location;
	readonly errored: boolean;
	readonly orphan: boolean;
	readonly timerId: string | null;
}

type MarkerKind = string;

const TIMER_REGISTRATION_NAMES = new Set(["setTimeout", "setInterval"]);
const TIMER_CLEAR_NAMES = new Set(["clearTimeout", "clearInterval"]);
const TIMER_CALLBACK_NAMES = TIMER_REGISTRATION_NAMES;

function isTimerRegistrationMarker(event: InvocationEvent): boolean {
	return (
		event.kind === "system.call" && TIMER_REGISTRATION_NAMES.has(event.name)
	);
}

function isTimerClearMarker(event: InvocationEvent): boolean {
	return event.kind === "system.call" && TIMER_CLEAR_NAMES.has(event.name);
}

function isTimerCallbackRequest(event: InvocationEvent): boolean {
	return (
		event.kind === "system.request" && TIMER_CALLBACK_NAMES.has(event.name)
	);
}

function isAnyTimerEvent(event: InvocationEvent): boolean {
	return (
		isTimerRegistrationMarker(event) ||
		isTimerClearMarker(event) ||
		((event.kind === "system.request" ||
			event.kind === "system.response" ||
			event.kind === "system.error") &&
			TIMER_CALLBACK_NAMES.has(event.name))
	);
}

interface LaidOutMarker {
	readonly kind: MarkerKind;
	readonly name: string;
	readonly seq: number;
	readonly ts: number;
	readonly row: number;
	readonly location: Location;
	readonly timerId: string | null;
	readonly auto: boolean;
	readonly budget?: number;
	readonly observed?: number;
}

interface LaidOutConnector {
	readonly timerId: string;
	readonly setSeq: number;
	readonly requestSeq: number;
	readonly originX: number;
	readonly originY: number;
	readonly targetX: number;
	readonly targetY: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(value: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return (value / total) * PERCENT_MULTIPLIER;
}

function fmtPct(value: number): string {
	return `${value.toFixed(PERCENT_FRACTION_DIGITS)}%`;
}

// ---------------------------------------------------------------------------
// Event-kind discriminators
// ---------------------------------------------------------------------------

function barKindFromEventKind(kind: string): BarKind | null {
	if (kind.startsWith("trigger.")) {
		return "trigger";
	}
	if (kind.startsWith("action.")) {
		return "action";
	}
	if (
		kind.endsWith(".request") ||
		kind.endsWith(".response") ||
		kind.endsWith(".error")
	) {
		return "rest";
	}
	return null;
}

function isRequestKind(kind: string): boolean {
	return kind.endsWith(".request");
}

function isResponseKind(kind: string): boolean {
	return kind.endsWith(".response");
}

function isErrorKind(kind: string): boolean {
	return kind.endsWith(".error");
}

function timerIdFromEvent(event: InvocationEvent): string | null {
	const input = event.input as { timerId?: unknown } | undefined;
	if (
		input &&
		typeof input === "object" &&
		input !== null &&
		"timerId" in input
	) {
		const id = input.timerId;
		if (typeof id === "string") {
			return id;
		}
		if (typeof id === "number") {
			return String(id);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Layout {
	readonly bars: readonly LaidOutBar[];
	readonly markers: readonly LaidOutMarker[];
	readonly connectors: readonly LaidOutConnector[];
	readonly mainRows: number;
	readonly trackRows: number;
	// Index of the dedicated leaf-marker row inside each lane, or null
	// when the lane has no markers. Used by the SVG emitter to override
	// `marker.row` so all leaf icons cluster on a single row at the bottom
	// of their lane instead of overlapping their parent bar.
	readonly mainMarkerRow: number | null;
	readonly trackMarkerRow: number | null;
	readonly totalDurationTs: number;
	readonly triggerEvent: InvocationEvent;
	readonly terminalEvent: InvocationEvent;
	readonly status: "succeeded" | "failed";
}

interface RowBucket {
	subRows: Array<Array<{ start: number; end: number }>>;
}

function greedyAssignSubRow(
	bucket: RowBucket,
	start: number,
	end: number,
): number {
	for (let sr = 0; sr < bucket.subRows.length; sr++) {
		const rows = bucket.subRows[sr];
		if (!rows) {
			continue;
		}
		const overlap = rows.some((r) => start < r.end && end > r.start);
		if (!overlap) {
			rows.push({ start, end });
			return sr;
		}
	}
	const newRow = [{ start, end }];
	bucket.subRows.push(newRow);
	return bucket.subRows.length - 1;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single-pass layout pipeline — classification, pairing, row assignment, marker+connector emission are sequential and sharing local maps keeps them cheap; splitting would require passing the event index, location map, depth map, and bucket state through multiple call frames.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same pipeline — the long body is a sequence of independent phases rather than a single tangled algorithm.
function computeLayout(events: readonly InvocationEvent[]): Layout | null {
	const triggerEvent = events.find(
		(e) => e.kind === "trigger.request" && e.ref === null,
	);
	if (!triggerEvent) {
		return null;
	}

	const terminalEvent = events.find(
		(e) =>
			(e.kind === "trigger.response" || e.kind === "trigger.error") &&
			e.ref === triggerEvent.seq,
	);
	if (!terminalEvent) {
		return null;
	}

	const totalDurationTs = Math.max(1, terminalEvent.ts - triggerEvent.ts);
	const status: "succeeded" | "failed" =
		terminalEvent.kind === "trigger.response" ? "succeeded" : "failed";

	const bySeq = new Map<number, InvocationEvent>();
	for (const e of events) {
		bySeq.set(e.seq, e);
	}

	const location = new Map<number, Location>();
	const depthInLocation = new Map<number, number>();

	function classify(event: InvocationEvent): Location {
		const cached = location.get(event.seq);
		if (cached) {
			return cached;
		}
		if (event.ref === null) {
			if (isTimerCallbackRequest(event)) {
				location.set(event.seq, "track");
				depthInLocation.set(event.seq, 0);
				return "track";
			}
			location.set(event.seq, "main");
			depthInLocation.set(event.seq, 0);
			return "main";
		}
		const parent = bySeq.get(event.ref);
		if (!parent) {
			location.set(event.seq, "main");
			depthInLocation.set(event.seq, 0);
			return "main";
		}
		const parentLoc = classify(parent);
		const parentDepth = depthInLocation.get(parent.seq) ?? 0;
		location.set(event.seq, parentLoc);
		depthInLocation.set(event.seq, parentDepth + 1);
		return parentLoc;
	}

	for (const e of events) {
		classify(e);
	}

	const terminalByRef = new Map<number, InvocationEvent>();
	for (const e of events) {
		if ((isResponseKind(e.kind) || isErrorKind(e.kind)) && e.ref !== null) {
			terminalByRef.set(e.ref, e);
		}
	}

	const mainBuckets = new Map<number, RowBucket>();
	const trackBuckets = new Map<number, RowBucket>();
	const getBucket = (loc: Location, depth: number): RowBucket => {
		const map = loc === "main" ? mainBuckets : trackBuckets;
		let b = map.get(depth);
		if (!b) {
			b = { subRows: [] };
			map.set(depth, b);
		}
		return b;
	};

	const requestEvents = events
		.filter((e) => isRequestKind(e.kind))
		.slice()
		.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

	const bars: LaidOutBar[] = [];
	const subRowByRequestSeq = new Map<number, number>();

	for (const req of requestEvents) {
		const kind = barKindFromEventKind(req.kind);
		if (!kind) {
			continue;
		}
		const loc = location.get(req.seq) ?? "main";
		const depth = depthInLocation.get(req.seq) ?? 0;
		const terminal = terminalByRef.get(req.seq) ?? null;
		let endTs: number;
		let orphan = false;
		if (terminal) {
			endTs = terminal.ts;
		} else {
			endTs = terminalEvent.ts;
			orphan = true;
		}
		const startTs = req.ts;
		const bucket = getBucket(loc, depth);
		const subRow = greedyAssignSubRow(bucket, startTs, endTs);
		subRowByRequestSeq.set(req.seq, subRow);
		const errored = Boolean(terminal && isErrorKind(terminal.kind));
		const timerId = isAnyTimerEvent(req) ? timerIdFromEvent(req) : null;
		bars.push({
			kind,
			name: req.name,
			requestSeq: req.seq,
			terminalSeq: terminal ? terminal.seq : null,
			startTs,
			endTs,
			row: -1,
			location: loc,
			errored,
			orphan,
			timerId,
		});
	}

	const mainDepthOffsets: number[] = [];
	let mainOffset = 0;
	const mainMaxDepth = Math.max(-1, ...Array.from(mainBuckets.keys()));
	for (let d = 0; d <= mainMaxDepth; d++) {
		mainDepthOffsets[d] = mainOffset;
		const subs = mainBuckets.get(d)?.subRows.length ?? 0;
		mainOffset += Math.max(1, subs);
		if (subs === 0) {
			mainOffset -= 1;
			mainDepthOffsets[d] = -1;
		}
	}
	const mainRows = mainOffset;

	const trackDepthOffsets: number[] = [];
	let trackOffset = 0;
	const trackMaxDepth = Math.max(-1, ...Array.from(trackBuckets.keys()));
	for (let d = 0; d <= trackMaxDepth; d++) {
		trackDepthOffsets[d] = trackOffset;
		const subs = trackBuckets.get(d)?.subRows.length ?? 0;
		trackOffset += Math.max(1, subs);
		if (subs === 0) {
			trackOffset -= 1;
			trackDepthOffsets[d] = -1;
		}
	}
	const trackRows = trackOffset;

	const laidOutBars = bars.map((b) => {
		const depth = depthInLocation.get(b.requestSeq) ?? 0;
		const subRow = subRowByRequestSeq.get(b.requestSeq) ?? 0;
		const offsets =
			b.location === "main" ? mainDepthOffsets : trackDepthOffsets;
		const offset = offsets[depth];
		const row = offset === undefined || offset === -1 ? depth : offset + subRow;
		return { ...b, row };
	});

	const rowBySeq = new Map<number, { row: number; location: Location }>();
	rowBySeq.set(triggerEvent.seq, { row: 0, location: "main" });
	for (const b of laidOutBars) {
		rowBySeq.set(b.requestSeq, { row: b.row, location: b.location });
	}

	// Markers render on a dedicated lane below the bars (one row per
	// location). They keep their parent's location for grouping but their
	// row is overridden in buildSvgPieces to the lane's marker-row index;
	// the parent association still reads from the timer connectors and the
	// shared x position (timestamp).
	const markers: LaidOutMarker[] = [];
	for (const e of events) {
		if (
			isRequestKind(e.kind) ||
			isResponseKind(e.kind) ||
			isErrorKind(e.kind)
		) {
			continue;
		}
		const auto = isTimerClearMarker(e) && e.ref === null;
		let row = 0;
		let loc: Location = "main";
		if (auto) {
			row = 0;
			loc = "main";
		} else if (e.ref !== null) {
			const parent = rowBySeq.get(e.ref);
			if (parent) {
				row = parent.row;
				loc = parent.location;
			}
		}
		const timerId = isAnyTimerEvent(e) ? timerIdFromEvent(e) : null;
		let budget: number | undefined;
		let observed: number | undefined;
		if (e.kind === "system.exhaustion") {
			const input = e.input as
				| { budget?: unknown; observed?: unknown }
				| undefined;
			if (input && typeof input.budget === "number") {
				budget = input.budget;
			}
			if (input && typeof input.observed === "number") {
				observed = input.observed;
			}
		}
		markers.push({
			kind: e.kind,
			name: e.name,
			seq: e.seq,
			ts: e.ts,
			row,
			location: loc,
			timerId,
			auto,
			...(budget === undefined ? {} : { budget }),
			...(observed === undefined ? {} : { observed }),
		});
	}

	// All leaf markers share a single row per lane. When multiple markers
	// fall within icon-width of each other in *rendered pixels*, the
	// client-side updateMarkerClusters() collapses them into a single
	// representative icon with an "Nx" badge; the tooltip lists each
	// member event. As the user zooms in, gaps grow and clusters split
	// apart automatically. Doing the clustering in JS lets it react to
	// the canvas's actual pixel width — a static SSR sub-row count is
	// always wrong at some zoom level.
	const mainHasMarkers = markers.some((m) => m.location === "main");
	const trackHasMarkers = markers.some((m) => m.location === "track");
	const mainMarkerRow = mainHasMarkers ? mainRows : null;
	const trackMarkerRow = trackHasMarkers ? trackRows : null;
	const mainRowsTotal = mainRows + (mainHasMarkers ? 1 : 0);
	const trackRowsTotal = trackRows + (trackHasMarkers ? 1 : 0);

	const connectors: LaidOutConnector[] = [];
	const setMarkers = markers.filter(
		(m) =>
			m.kind === "system.call" &&
			TIMER_REGISTRATION_NAMES.has(m.name) &&
			m.timerId,
	);
	for (const setM of setMarkers) {
		const originX = pct(setM.ts - triggerEvent.ts, totalDurationTs);
		const setMRow =
			(setM.location === "main" ? mainMarkerRow : trackMarkerRow) ?? setM.row;
		const originY =
			yForRow(setMRow, setM.location, mainRowsTotal) + BAR_HEIGHT_PX;
		for (const bar of laidOutBars) {
			if (bar.timerId === null || bar.timerId !== setM.timerId) {
				continue;
			}
			const targetX = pct(bar.startTs - triggerEvent.ts, totalDurationTs);
			const targetY = yForRow(bar.row, bar.location, mainRowsTotal);
			connectors.push({
				timerId: setM.timerId ?? "",
				setSeq: setM.seq,
				requestSeq: bar.requestSeq,
				originX,
				originY,
				targetX,
				targetY,
			});
		}
	}

	return {
		bars: laidOutBars,
		markers,
		connectors,
		mainRows: Math.max(mainRowsTotal, 1),
		trackRows: trackRowsTotal,
		mainMarkerRow,
		trackMarkerRow,
		totalDurationTs,
		triggerEvent,
		terminalEvent,
		status,
	};
}

// ---------------------------------------------------------------------------
// Y-position helpers
// ---------------------------------------------------------------------------

function yForRow(row: number, loc: Location, mainRows: number): number {
	if (loc === "main") {
		return row * ROW_HEIGHT_PX + BAR_Y_OFFSET_PX;
	}
	const trackTopPx =
		mainRows * ROW_HEIGHT_PX + TRACK_DIVIDER_GAP_PX + TRACK_LABEL_HEIGHT_PX;
	return trackTopPx + row * ROW_HEIGHT_PX + BAR_Y_OFFSET_PX;
}

// ---------------------------------------------------------------------------
// SVG render
// ---------------------------------------------------------------------------

interface RenderedSvgPieces {
	readonly svgShapes: string;
	readonly svgTexts: string;
	readonly svgHeight: number;
}

function bigintToNumber(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") {
		return Number(value);
	}
	return value;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function markerVariantClass(m: LaidOutMarker): string {
	if (m.kind === "system.call" && TIMER_REGISTRATION_NAMES.has(m.name)) {
		return "flame-marker--timer-set";
	}
	if (m.kind === "system.call" && TIMER_CLEAR_NAMES.has(m.name)) {
		return m.auto
			? "flame-marker--timer-clear flame-marker--auto"
			: "flame-marker--timer-clear";
	}
	if (m.kind === "system.exception") {
		return "flame-marker--exception";
	}
	if (m.kind === "system.exhaustion") {
		return "flame-marker--exhaustion";
	}
	return "flame-marker--call";
}

// Compose an informative tooltip — name first (so fetch-style "POST
// https://…" detail appears on hover for every host call), then kind-
// specific suffixes (budget / observed for exhaustion, timer id for the
// timer family).
function markerTitleText(m: LaidOutMarker): string {
	if (m.kind === "system.exhaustion" && m.budget !== undefined) {
		const observedPart =
			m.observed === undefined ? "" : `, observed=${m.observed}`;
		return `${m.kind}: ${m.name} (budget=${m.budget}${observedPart})`;
	}
	if (m.timerId) {
		return `${m.name} (timerId=${m.timerId})`;
	}
	return `${m.kind}: ${m.name}`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SSR emitter for bar/marker/connector/text/clip categories — inlined so we emit a single string[] per layer in deterministic document order; splitting would duplicate shared state (triggerTs, total, mainRows, escape helpers, icon-id resolution).
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same — length comes from per-kind variant handling, not branching depth.
function buildSvgPieces(
	layout: Layout,
	triggerKind: string | undefined,
): RenderedSvgPieces {
	const shapes: string[] = [];
	const texts: string[] = [];
	const triggerTs = layout.triggerEvent.ts;
	const total = layout.totalDurationTs;

	// Defs: hatched pattern for orphan bars + icon sprite. Both live in a
	// single <defs> so the parser only opens one.
	shapes.push(
		`<defs><pattern id="flame-hatched" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="currentColor" fill-opacity="0.15"/><line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.6"/></pattern>${flameIconSprite()}</defs>`,
	);

	// Bars + per-bar clipPath. Each bar emits a coloured `<rect>` (the
	// click target + tooltip) plus a `<clipPath id="bc-N">` whose rect
	// matches the bar's bbox. Bar icon, label, and right-edge glyphs are
	// rendered in the SAME outer SVG coordinate space and reference
	// `clip-path="url(#bc-N)"`; SVG `clipPath` is the one rendering
	// primitive that *every* engine clips correctly (Firefox + Chrome
	// both honour CSS `overflow:hidden` on a nested <svg> inconsistently
	// — empirically observed bar-text bleeding into neighbour bars).
	const clipDefs: string[] = [];
	for (const bar of layout.bars) {
		const x = pct(bar.startTs - triggerTs, total);
		const rawWidth = pct(bar.endTs - bar.startTs, total);
		// No min-width clamp: per Brendan-Gregg flame chart design, sub-µs
		// bars stay sub-pixel and visually disappear at low zoom. Padding
		// them out artificially causes adjacent sequential bars to visibly
		// overlap (and their labels to render in the same pixels), which
		// looks like concurrency where there is none.
		const width = rawWidth;
		const y = yForRow(bar.row, bar.location, layout.mainRows);
		const classes = ["flame-bar", `kind-${bar.kind}`];
		if (bar.errored) {
			classes.push("bar-error");
		}
		if (bar.orphan) {
			classes.push("orphan");
		}
		const dataTimerId = bar.timerId
			? ` data-timer-id="${escapeHtml(bar.timerId)}"`
			: "";
		const terminal = bar.terminalSeq === null ? "" : String(bar.terminalSeq);
		const dataEventPair = ` data-event-pair="${bar.requestSeq}-${escapeHtml(terminal)}"`;
		const titleText = bar.orphan
			? `${bar.name} (no terminal event recorded)`
			: bar.name;
		const barTitle = `<title>${escapeHtml(titleText)}</title>`;
		const xPct = fmtPct(x);
		const widthPct = fmtPct(width);
		const clipId = `bc-${bar.requestSeq}`;
		shapes.push(
			`<rect class="${classes.join(" ")}" x="${xPct}" y="${y}" width="${widthPct}" height="${BAR_HEIGHT_PX}" rx="2"${dataTimerId}${dataEventPair}>${barTitle}</rect>`,
		);
		clipDefs.push(
			`<clipPath id="${clipId}"><rect x="${xPct}" y="${y}" width="${widthPct}" height="${BAR_HEIGHT_PX}"/></clipPath>`,
		);

		const iconId = iconForBar(bar.kind, bar.name, triggerKind);
		const yMid = y + BAR_HEIGHT_PX / HALF + 1;
		const yIcon = y + (BAR_HEIGHT_PX - ICON_SIZE_PX) / HALF;
		// Wrap the bar's content in a <g clip-path="url(#bc-N)"> with NO
		// transform of its own. Per SVG spec, when clip-path and transform
		// are on the SAME element the clipPath rect is transformed too,
		// so the clip region tracks the element instead of staying at
		// the bar's bbox — empirically this lets text bleed into the
		// next bar. Putting the clip on a non-transformed wrapper keeps
		// the clip region pinned to the bar while inner children remain
		// free to use SVG `transform="translate(N 0)"` for fixed-pixel
		// insets that don't drift with zoom.
		const inner: string[] = [];
		if (iconId !== null) {
			inner.push(
				`<use class="flame-bar-icon" href="#fi-${iconId}" x="${xPct}" y="${yIcon}" width="${MARKER_WIDTH_PX}" height="${ICON_SIZE_PX}" transform="translate(4 0)"/>`,
			);
		}
		const labelDx = iconId === null ? 4 : 22;
		inner.push(
			`<text class="bar-label" x="${xPct}" y="${yMid}" transform="translate(${labelDx} 0)">${escapeHtml(shortLabelFor(bar.name))}</text>`,
		);
		// Duration label is always emitted (the SSR-time `bar.width >= N%`
		// gate was invariant under zoom: at any zoom level the bar's % of
		// canvas is the same, so a "5%" bar that's 80px at 100% zoom is
		// still 5% — and so still 8000px at 100x zoom — but the gate
		// rejected it the same way). Static JS hides the label at runtime
		// (toggleBarLabels in flamegraph.js) when the bar's actual pixel
		// width can't fit both name + duration without overlap.
		const duration = formatDurationUs(bar.endTs - bar.startTs);
		const dimDx = bar.errored ? -22 : -4;
		inner.push(
			`<text class="bar-label-dim" x="${fmtPct(x + width)}" y="${yMid}" text-anchor="end" transform="translate(${dimDx} 0)">${escapeHtml(duration)}</text>`,
		);
		if (bar.errored) {
			inner.push(
				`<text class="bar-error-icon" x="${fmtPct(x + width)}" y="${yMid}" text-anchor="end" transform="translate(-4 0)">⚠</text>`,
			);
		}
		texts.push(
			`<g clip-path="url(#${clipId})" pointer-events="none">${inner.join("")}</g>`,
		);
	}

	// Emit clipPath defs at the end of the shapes list — they are
	// non-rendering, so their position only affects reference resolution
	// (forward refs are legal in SVG).
	if (clipDefs.length > 0) {
		shapes.push(`<defs>${clipDefs.join("")}</defs>`);
	}

	// Markers — single <use> per marker referencing the icon sprite. The
	// rendering is uniform across kinds (timer set, timer clear, generic
	// host call, exception, exhaustion); the icon glyph itself conveys the
	// kind, classes only carry hit-target / theming hooks.
	for (const m of layout.markers) {
		const x = pct(m.ts - triggerTs, total);
		// Override the marker's parent-derived row with the lane's
		// dedicated marker lane (base row + greedy sub-row) so leaf icons
		// (a) cluster below the bars instead of overlapping their parents
		// and (b) stack vertically when many markers fire close together.
		const markerLaneBase =
			(m.location === "main" ? layout.mainMarkerRow : layout.trackMarkerRow) ??
			m.row;
		const markerRow = markerLaneBase;
		const y = yForRow(markerRow, m.location, layout.mainRows);
		const dataTimerId = m.timerId
			? ` data-timer-id="${escapeHtml(m.timerId)}"`
			: "";
		const dataEventSeq = ` data-event-seq="${m.seq}"`;
		const iconId = iconForMarker(m.kind, m.name);
		const variantClass = markerVariantClass(m);
		const titleText = markerTitleText(m);
		const iconY = y + (BAR_HEIGHT_PX - ICON_SIZE_PX) / HALF;
		const iconX = fmtPct(x);
		// `<use>` referencing a `<symbol>` is unreliable as a hit target:
		// Firefox often only triggers click/hover on the icon's stroke
		// pixels (where the SVG paint is opaque) rather than the bounding
		// box, and `<title>` inside `<use>` doesn't surface as a tooltip
		// in Firefox at all. Wrap each marker in a <g> with a transparent
		// hit rect that owns the click + title; the visible <use> sits
		// above with pointer-events:none. Result: full bbox is clickable,
		// tooltip appears on hover anywhere in the icon area.
		// data-marker-ts encodes the event's offset from the trigger ts in
		// the same units as the ruler (microseconds). updateMarkerClusters
		// in flamegraph.js uses it to compute pixel x at any zoom level
		// without parsing percentage strings.
		const markerTs = m.ts - triggerTs;
		shapes.push(
			`<g class="flame-marker ${variantClass}"${dataTimerId}${dataEventSeq} data-marker-ts="${markerTs}" data-marker-row-y="${iconY}"><title>${escapeHtml(titleText)}</title><rect class="flame-marker-hit" x="${iconX}" y="${iconY}" width="${MARKER_WIDTH_PX}" height="${ICON_SIZE_PX}"/><use class="flame-marker-icon" href="#fi-${iconId}" x="${iconX}" y="${iconY}" width="${MARKER_WIDTH_PX}" height="${ICON_SIZE_PX}" pointer-events="none"/></g>`,
		);
	}

	// Connectors.
	for (const c of layout.connectors) {
		const d = `M ${fmtPct(c.originX)} ${c.originY} L ${fmtPct(c.targetX)} ${c.targetY}`;
		shapes.push(
			`<path class="timer-connector" d="${d}" data-timer-id="${escapeHtml(c.timerId)}"/>`,
		);
	}

	const svgHeight =
		layout.mainRows * ROW_HEIGHT_PX +
		(layout.trackRows > 0
			? TRACK_DIVIDER_GAP_PX +
				TRACK_LABEL_HEIGHT_PX +
				layout.trackRows * ROW_HEIGHT_PX
			: 0) +
		BAR_Y_OFFSET_PX;

	if (layout.trackRows > 0 || hasAnyTimerMarker(layout)) {
		const dividerY = layout.mainRows * ROW_HEIGHT_PX + TRACK_DIVIDER_GAP_PX / 2;
		shapes.push(
			`<line class="flame-track-divider" x1="0" y1="${dividerY}" x2="100%" y2="${dividerY}"/>`,
		);
		const labelY = dividerY + TRACK_LABEL_HEIGHT_PX;
		const labelText =
			layout.trackRows > 0
				? "TIMER CALLBACKS"
				: "TIMER CALLBACKS (empty — no fires)";
		texts.push(
			`<text class="flame-track-label" x="5" y="${labelY}">${labelText}</text>`,
		);
	}

	return {
		svgShapes: shapes.join(""),
		svgTexts: texts.join(""),
		svgHeight,
	};
}

function hasAnyTimerMarker(layout: Layout): boolean {
	return layout.markers.some(
		(m) =>
			m.kind === "system.call" &&
			(TIMER_REGISTRATION_NAMES.has(m.name) || TIMER_CLEAR_NAMES.has(m.name)),
	);
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

function FlameEmpty() {
	return (
		<div class="flame-empty">No flamegraph available for this invocation.</div>
	);
}

function renderRuler(totalDurationTs: number): string {
	// Ruler tick labels are emitted by static/flamegraph.js based on the
	// container's visible time range (scrollLeft + width / canvas-width →
	// visible-ts → "nice" tick step). SSR only emits the empty SVG with
	// the totalDurationTs metadata; client JS rebuilds ticks on every
	// zoom + scroll event so the labels always reflect what's on screen
	// (a pure-SSR ruler would show ticks at 0/25/50/75/100% of the full
	// duration — at deep zoom only the leftmost tick stays in view).
	return `<svg class="flame-ruler" width="100%" height="${RULER_HEIGHT_PX}" data-total-ts="${totalDurationTs}" xmlns="http://www.w3.org/2000/svg"><line class="flame-ruler-tick" x1="0" y1="15" x2="100%" y2="15"/></svg>`;
}

interface LegendPresence {
	readonly hasTrigger: boolean;
	readonly hasAction: boolean;
	readonly hasRest: boolean;
	readonly hasOrphan: boolean;
	readonly hasTimerSet: boolean;
	readonly hasTimerClear: boolean;
	readonly hasCallMarker: boolean;
	readonly hasException: boolean;
	readonly hasExhaustion: boolean;
}

function detectBarPresence(
	bars: readonly LaidOutBar[],
): Pick<LegendPresence, "hasTrigger" | "hasAction" | "hasRest" | "hasOrphan"> {
	let hasTrigger = false;
	let hasAction = false;
	let hasRest = false;
	let hasOrphan = false;
	for (const bar of bars) {
		if (bar.orphan) {
			hasOrphan = true;
		}
		if (bar.kind === "trigger") {
			hasTrigger = true;
		} else if (bar.kind === "action") {
			hasAction = true;
		} else {
			hasRest = true;
		}
	}
	return { hasTrigger, hasAction, hasRest, hasOrphan };
}

function detectMarkerPresence(
	markers: readonly LaidOutMarker[],
): Pick<
	LegendPresence,
	| "hasTimerSet"
	| "hasTimerClear"
	| "hasCallMarker"
	| "hasException"
	| "hasExhaustion"
> {
	let hasTimerSet = false;
	let hasTimerClear = false;
	let hasCallMarker = false;
	let hasException = false;
	let hasExhaustion = false;
	for (const m of markers) {
		if (m.kind === "system.exception") {
			hasException = true;
		} else if (m.kind === "system.exhaustion") {
			hasExhaustion = true;
		} else if (
			m.kind === "system.call" &&
			TIMER_REGISTRATION_NAMES.has(m.name)
		) {
			hasTimerSet = true;
		} else if (m.kind === "system.call" && TIMER_CLEAR_NAMES.has(m.name)) {
			hasTimerClear = true;
		} else {
			hasCallMarker = true;
		}
	}
	return {
		hasTimerSet,
		hasTimerClear,
		hasCallMarker,
		hasException,
		hasExhaustion,
	};
}

function detectLegendPresence(layout: Layout): LegendPresence {
	return {
		...detectBarPresence(layout.bars),
		...detectMarkerPresence(layout.markers),
	};
}

function LegendIcon({ id }: { id: string }) {
	return (
		<svg
			class="flame-legend-icon"
			viewBox="0 0 24 24"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<use href={`#fi-${id}`} />
		</svg>
	);
}

function Legend({ presence }: { presence: LegendPresence }) {
	const items = [
		presence.hasTrigger && (
			<span class="flame-legend-item">
				<span class="flame-legend-swatch flame-legend-swatch--trigger" />
				trigger
			</span>
		),
		presence.hasAction && (
			<span class="flame-legend-item">
				<span class="flame-legend-swatch flame-legend-swatch--action" />
				action
			</span>
		),
		presence.hasRest && (
			<span class="flame-legend-item">
				<span class="flame-legend-swatch flame-legend-swatch--rest" />
				fetch / sql / queue / other
			</span>
		),
		presence.hasOrphan && (
			<span class="flame-legend-item">
				<span class="flame-legend-swatch flame-legend-swatch--orphan" />
				orphan (no terminal)
			</span>
		),
		presence.hasTimerSet && (
			<span class="flame-legend-item">
				<LegendIcon id="timer" />
				timer set
			</span>
		),
		presence.hasTimerClear && (
			<span class="flame-legend-item">
				<LegendIcon id="timer-off" />
				timer cleared
			</span>
		),
		presence.hasCallMarker && (
			<span class="flame-legend-item">
				<LegendIcon id="circle-question-mark" />
				host call
			</span>
		),
		presence.hasException && (
			<span class="flame-legend-item flame-legend-item--danger">
				<LegendIcon id="triangle-alert" />
				exception
			</span>
		),
		presence.hasExhaustion && (
			<span class="flame-legend-item flame-legend-item--danger">
				<LegendIcon id="circle-x" />
				exhaustion
			</span>
		),
	].filter(Boolean);
	if (items.length === 0) {
		return null;
	}
	return (
		<section class="flame-legend" aria-label="Legend">
			{items}
		</section>
	);
}

function dispatchUserName(
	events: readonly InvocationEvent[],
): string | undefined {
	const triggerReq = events.find((e) => e.kind === "trigger.request");
	const dispatchMeta = (triggerReq?.meta as { dispatch?: unknown } | undefined)
		?.dispatch as { user?: { name?: unknown } } | undefined;
	return typeof dispatchMeta?.user?.name === "string"
		? dispatchMeta.user.name
		: undefined;
}

function TriggeredBy({ name }: { name: string }) {
	return (
		<span class="flame-header-triggered-by">
			triggered by <strong>{name}</strong>
		</span>
	);
}

function TriggerExceptionFragment({ event }: { event: InvocationEvent }) {
	const stage = (event.input as { stage?: unknown } | undefined)?.stage;
	const cause = event.name;
	const message = event.error?.message ?? "";
	const stageSuffix = typeof stage === "string" && stage ? ` (${stage})` : "";
	const title = message
		? `${cause}${stageSuffix}: ${message}`
		: `${cause}${stageSuffix}`;
	return (
		<div class="flame-fragment flame-fragment--exception">
			<div class="flame-exception" role="img" aria-label={title}>
				<span class="flame-exception-name">{`${cause}${stageSuffix}`}</span>
				<span class="flame-exception-sep">·</span>
				<span class="flame-exception-message">{message}</span>
			</div>
		</div>
	);
}

function Flamegraph({
	events,
	triggerKind,
}: {
	events: readonly InvocationEvent[];
	triggerKind?: string;
}) {
	if (events.length === 0) {
		return <FlameEmpty />;
	}
	if (events.length === 1 && events[0]?.kind === "trigger.exception") {
		return <TriggerExceptionFragment event={events[0]} />;
	}
	const layout = computeLayout(events);
	if (!layout) {
		return <FlameEmpty />;
	}

	const { svgShapes, svgTexts, svgHeight } = buildSvgPieces(
		layout,
		triggerKind,
	);
	const ruler = renderRuler(layout.totalDurationTs);

	const dispatcher = dispatchUserName(events);

	// Document order: shapes (defs + sprite + bars + markers + connectors +
	// divider) → texts (per-bar nested <svg overflow=hidden> wrappers, plus
	// the track label). Text wrappers render after rects so they paint on
	// top.
	const svg =
		`<svg class="flame-graph" width="100%" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">` +
		svgShapes +
		svgTexts +
		"</svg>";

	const eventsJson = JSON.stringify(events, bigintToNumber).replace(
		/</g,
		"\\u003c",
	);

	return (
		<div class="flame-fragment">
			{dispatcher && (
				<div class="flame-header-metrics">
					<TriggeredBy name={dispatcher} />
				</div>
			)}
			<div class="flame-container">
				<div class="flame-canvas">
					{raw(ruler)}
					{raw(svg)}
				</div>
			</div>
			<Legend presence={detectLegendPresence(layout)} />
			<script type="application/json" class="flame-events">
				{raw(eventsJson)}
			</script>
		</div>
	);
}

function renderFlamegraph(
	events: readonly InvocationEvent[],
	triggerKind?: string,
) {
	const props =
		triggerKind === undefined ? { events } : { events, triggerKind };
	return (<Flamegraph {...props} />).toString();
}

export type { LaidOutBar, LaidOutConnector, LaidOutMarker, Layout };
export { Flamegraph, renderFlamegraph };
