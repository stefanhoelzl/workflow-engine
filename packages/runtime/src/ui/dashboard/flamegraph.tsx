import type { InvocationEvent } from "@workflow-engine/core";
import { raw } from "hono/html";
import { formatDurationUs } from "./page.js";

// Chrome (legend, metrics, header, error fragment, top-level wrapper) is
// JSX. SVG body is machine-generated content built via string concatenation
// in `buildSvgPieces` / `renderRuler` and bridged into the JSX tree via
// `{raw(svg)}` / `{raw(ruler)}`. Two-natures rationale: SVG body is
// hundreds of computed-coordinate elements per render — readability win
// from JSX is zero, output bytes change cost is real (existing
// flamegraph.test.ts assertions depend on byte shape). See migration
// design.md Decision 5.

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT_PX = 22;
const BAR_HEIGHT_PX = 18;
const BAR_Y_OFFSET_PX = 2;
const TRACK_DIVIDER_GAP_PX = 12;
const TRACK_LABEL_HEIGHT_PX = 14;
const MARKER_WIDTH_VIEWBOX = 16;
const MIN_BAR_WIDTH_VIEWBOX = 4;
const VIEWBOX_WIDTH = 1000;
const RULER_HEIGHT_PX = 18;
const RULER_TICK_COUNT = 5;
const PERCENT_MULTIPLIER = 100;
const PERCENT_FRACTION_DIGITS = 4;
const COORD_FRACTION_DIGITS = 2;
const MARKER_X_INSET = 2;
const MARKER_X_VERTICAL_INSET = 3;
const HALF = 2;
const BAR_LABEL_X_INSET_PCT = 0.3;
const BAR_LABEL_Y_OFFSET = 1;
const BAR_LABEL_MIN_PCT_FOR_NAME = 6;
const BAR_LABEL_MIN_PCT_FOR_DURATION = 12;
const ERROR_ICON_X_INSET = 2;
// Horizontal space (in percent of the flamegraph width) reserved to the
// right of a bar's duration label so the ⚠ icon can sit next to it without
// overlapping. Tuned so the glyph at var(--fs-xs) clears a one-digit duration.
const ERROR_ICON_RESERVE_PCT = 3;
const MARKER_CALL_RADIUS = 5;

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

// Markers are open-ended leaf events. After the bridge-main-sequencing
// prefix consolidation, this includes `system.call` (setTimeout
// registration, console.log, randomUUID, WASI clock/random, etc.) and
// `system.exception` (uncaught guest throws). Timer registration vs.
// arbitrary host calls is distinguished by the event's `name` field
// (`setTimeout`/`setInterval` for registration, `clearTimeout`/
// `clearInterval` for clears). The flamegraph renders bespoke glyphs for
// the timer family and falls back to a neutral circle for everything else.
type MarkerKind = string;

// Timer-family detection. Replaces the legacy `kind.startsWith("timer.")`
// check (now that `timer.*` no longer exists as a top-level prefix).
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
	// Populated for `system.exhaustion` events only; surfaced in the SVG
	// `<title>` so hovering identifies the configured cap and observed
	// value at breach. `name` already carries the dimension.
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
	// Any other <prefix>.request/.response/.error (fetch.*, timer.*, legacy
	// system.*, future plugin prefixes) groups into the generic "rest" lane.
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
	readonly totalDurationTs: number;
	readonly triggerEvent: InvocationEvent;
	readonly terminalEvent: InvocationEvent;
	readonly actionCount: number;
	readonly systemCount: number;
	readonly timerCount: number;
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

	// Index events by seq for fast lookup.
	const bySeq = new Map<number, InvocationEvent>();
	for (const e of events) {
		bySeq.set(e.seq, e);
	}

	// Classify each event as belonging to "main" or "track" based on its ref-chain root.
	//   - trigger.request (ref=null) → main root
	//   - timer-callback system.request (ref=null) → track root
	//   - non-null ref → inherit location from parent
	//   - timer-clear system.call with ref=null (auto-clear) → main (row 0)
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
			// trigger.request OR auto-clear timer system.call OR any other null-ref edge case → main
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

	// Pair up request events with their responses/errors.
	// Paired events = request_event -> terminal_event (response or error).
	// Map from request.seq → terminal event.
	const terminalByRef = new Map<number, InvocationEvent>();
	for (const e of events) {
		if ((isResponseKind(e.kind) || isErrorKind(e.kind)) && e.ref !== null) {
			terminalByRef.set(e.ref, e);
		}
	}

	// ------ Main-tree and timer-track row assignment ------
	// Each location has a bucket per depth. Assign bars (request events) to
	// sub-rows greedily by start ts.
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

	// Sort request events by start ts for deterministic greedy assignment.
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
			// Orphan: extend to terminal trigger event's ts.
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
			row: -1, // filled below after depth offsets are known
			location: loc,
			errored,
			orphan,
			timerId,
		});
	}

	// Compute physical-row offsets per location.
	const mainDepthOffsets: number[] = [];
	let mainOffset = 0;
	const mainMaxDepth = Math.max(-1, ...Array.from(mainBuckets.keys()));
	for (let d = 0; d <= mainMaxDepth; d++) {
		mainDepthOffsets[d] = mainOffset;
		const subs = mainBuckets.get(d)?.subRows.length ?? 0;
		mainOffset += Math.max(1, subs); // reserve at least one row per populated depth; unpopulated depths skipped below
		if (subs === 0) {
			// Depth not populated; pull back so we don't reserve.
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

	// Fill bar.row from depth + subRow.
	const laidOutBars = bars.map((b) => {
		const depth = depthInLocation.get(b.requestSeq) ?? 0;
		const subRow = subRowByRequestSeq.get(b.requestSeq) ?? 0;
		const offsets =
			b.location === "main" ? mainDepthOffsets : trackDepthOffsets;
		const offset = offsets[depth];
		const row = offset === undefined || offset === -1 ? depth : offset + subRow;
		return { ...b, row };
	});

	// ------ Markers ------
	// Each marker event (system.call leaves, system.exception) renders on the
	// row identified by its ref. For an auto-clear timer (system.call
	// name="clearTimeout/clearInterval") with ref=null, render on row 0 main
	// (the trigger row).
	const rowBySeq = new Map<number, { row: number; location: Location }>();
	rowBySeq.set(triggerEvent.seq, { row: 0, location: "main" });
	for (const b of laidOutBars) {
		rowBySeq.set(b.requestSeq, { row: b.row, location: b.location });
	}

	const markers: LaidOutMarker[] = [];
	for (const e of events) {
		// Leaf events are anything that isn't a paired request/response/error.
		// This includes timer registrations/clears (system.call name=
		// setTimeout/setInterval/clearTimeout/clearInterval), generic host
		// calls (system.call name=console.log, randomUUID, wasi.*, etc.),
		// and uncaught guest exceptions (system.exception).
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

	// ------ Connectors (system.call timer registration → each
	// system.request timer-callback with same timerId) ------
	const connectors: LaidOutConnector[] = [];
	const setMarkers = markers.filter(
		(m) =>
			m.kind === "system.call" &&
			TIMER_REGISTRATION_NAMES.has(m.name) &&
			m.timerId,
	);
	for (const setM of setMarkers) {
		const originX = pct(setM.ts - triggerEvent.ts, totalDurationTs);
		const originY = yForRow(setM.row, setM.location, mainRows) + BAR_HEIGHT_PX;
		for (const bar of laidOutBars) {
			if (bar.timerId === null || bar.timerId !== setM.timerId) {
				continue;
			}
			const targetX = pct(bar.startTs - triggerEvent.ts, totalDurationTs);
			const targetY = yForRow(bar.row, bar.location, mainRows);
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

	// Summary counts.
	let actionCount = 0;
	let systemCount = 0;
	let timerCount = 0;
	for (const e of events) {
		if (e.kind === "action.request") {
			actionCount += 1;
		} else if (e.kind === "system.request") {
			if (isTimerCallbackRequest(e)) {
				timerCount += 1;
			} else {
				systemCount += 1;
			}
		}
	}

	return {
		bars: laidOutBars,
		markers,
		connectors,
		mainRows: Math.max(mainRows, 1),
		trackRows,
		totalDurationTs,
		triggerEvent,
		terminalEvent,
		actionCount,
		systemCount,
		timerCount,
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SSR emitter for three element categories (bars, markers, connectors, text layer) with per-bar variants (orphan, errored, labels) — inlined here so we emit a single string[] in deterministic document order; splitting the emitters would duplicate the shared state (triggerTs, total, mainRows, escape helpers).
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same — the length comes from per-kind variant handling, not branching depth.
function buildSvgPieces(layout: Layout): RenderedSvgPieces {
	const shapes: string[] = [];
	const texts: string[] = [];
	const triggerTs = layout.triggerEvent.ts;
	const total = layout.totalDurationTs;

	// Defs: hatched pattern for orphan bars.
	shapes.push(
		`<defs><pattern id="flame-hatched" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="currentColor" fill-opacity="0.15"/><line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.6"/></pattern></defs>`,
	);

	// Bars (paired events).
	for (const bar of layout.bars) {
		const x = pct(bar.startTs - triggerTs, total);
		const rawWidth = pct(bar.endTs - bar.startTs, total);
		// Minimum width floor in viewBox units: MIN_BAR_WIDTH_VIEWBOX / VIEWBOX_WIDTH * 100%.
		const minPct = (MIN_BAR_WIDTH_VIEWBOX / VIEWBOX_WIDTH) * PERCENT_MULTIPLIER;
		const width = Math.max(rawWidth, minPct);
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
		const barTitle = bar.orphan
			? "<title>No terminal event recorded</title>"
			: "";
		shapes.push(
			`<rect class="${classes.join(" ")}" x="${fmtPct(x)}" y="${y}" width="${fmtPct(width)}" height="${BAR_HEIGHT_PX}" rx="2"${dataTimerId}${dataEventPair}>${barTitle}</rect>`,
		);
	}

	// Markers.
	for (const m of layout.markers) {
		const x = pct(m.ts - triggerTs, total);
		const y = yForRow(m.row, m.location, layout.mainRows);
		const markerWidthPct =
			(MARKER_WIDTH_VIEWBOX / VIEWBOX_WIDTH) * PERCENT_MULTIPLIER;
		const dataTimerId = m.timerId
			? ` data-timer-id="${escapeHtml(m.timerId)}"`
			: "";
		const dataEventSeq = ` data-event-seq="${m.seq}"`;
		const markerTitle = `<title>${escapeHtml(m.kind)}</title>`;
		const isTimerSet =
			m.kind === "system.call" && TIMER_REGISTRATION_NAMES.has(m.name);
		const isTimerClear =
			m.kind === "system.call" && TIMER_CLEAR_NAMES.has(m.name);
		if (isTimerSet) {
			shapes.push(
				`<rect class="marker-set" x="${fmtPct(x)}" y="${y}" width="${fmtPct(markerWidthPct)}" height="${BAR_HEIGHT_PX}"${dataTimerId}${dataEventSeq}>${markerTitle}</rect>`,
			);
		} else if (isTimerClear) {
			const autoClass = m.auto ? " marker-auto" : "";
			shapes.push(
				`<rect class="marker-clear-bg${autoClass}" x="${fmtPct(x)}" y="${y}" width="${fmtPct(markerWidthPct)}" height="${BAR_HEIGHT_PX}"${dataTimerId}${dataEventSeq}>${markerTitle}</rect>`,
			);
			// Two diagonal lines forming an ×.
			// Compute endpoints in viewBox units:
			//   left edge:  x%           → x viewBox = (x/100) * 1000
			//   right edge: x + markerW% → (x + markerW)/100 * 1000
			const xLeft = (x / PERCENT_MULTIPLIER) * VIEWBOX_WIDTH;
			const xRight = xLeft + MARKER_WIDTH_VIEWBOX;
			const yTop = y + MARKER_X_VERTICAL_INSET;
			const yBot = y + BAR_HEIGHT_PX - MARKER_X_VERTICAL_INSET;
			shapes.push(
				`<line class="marker-x${autoClass}" x1="${(xLeft + MARKER_X_INSET).toFixed(COORD_FRACTION_DIGITS)}" y1="${yTop}" x2="${(xRight - MARKER_X_INSET).toFixed(COORD_FRACTION_DIGITS)}" y2="${yBot}"${dataTimerId}${dataEventSeq}/>`,
			);
			shapes.push(
				`<line class="marker-x${autoClass}" x1="${(xRight - MARKER_X_INSET).toFixed(COORD_FRACTION_DIGITS)}" y1="${yTop}" x2="${(xLeft + MARKER_X_INSET).toFixed(COORD_FRACTION_DIGITS)}" y2="${yBot}"${dataTimerId}${dataEventSeq}/>`,
			);
		} else {
			// Generic leaf marker (wasi.*, system.call, system.exception,
			// system.exhaustion, future plugin leaves): a small filled circle
			// centered on the row. No per-kind CSS class; severity for
			// system.exhaustion is conveyed at the bar level via the synth
			// `trigger.error` close that drives the existing `errored: true`
			// styling.
			const cxPct = x + markerWidthPct / HALF;
			const cy = y + BAR_HEIGHT_PX / HALF;
			let titleText = `${m.kind}: ${m.name}`;
			if (m.kind === "system.exhaustion" && m.budget !== undefined) {
				const observedPart =
					m.observed === undefined ? "" : `, observed=${m.observed}`;
				titleText = `${m.kind}: ${m.name} (budget=${m.budget}${observedPart})`;
			}
			const title = `<title>${escapeHtml(titleText)}</title>`;
			shapes.push(
				`<circle class="marker-call" cx="${fmtPct(cxPct)}" cy="${cy}" r="${MARKER_CALL_RADIUS}"${dataEventSeq}>${title}</circle>`,
			);
		}
	}

	// Connectors.
	for (const c of layout.connectors) {
		const d = `M ${fmtPct(c.originX)} ${c.originY} L ${fmtPct(c.targetX)} ${c.targetY}`;
		shapes.push(
			`<path class="timer-connector" d="${d}" data-timer-id="${escapeHtml(c.timerId)}"/>`,
		);
	}

	// Text layer: bar labels (name primary + duration sub-caption when wide enough).
	for (const bar of layout.bars) {
		const x = pct(bar.startTs - triggerTs, total);
		const width = pct(bar.endTs - bar.startTs, total);
		const y =
			yForRow(bar.row, bar.location, layout.mainRows) + BAR_HEIGHT_PX / HALF;
		// Only render text when bar is wide enough. Name is left-aligned at
		// the bar's left edge; duration is right-aligned at the bar's right
		// edge so the two never collide.
		if (width >= BAR_LABEL_MIN_PCT_FOR_NAME) {
			texts.push(
				`<text class="bar-label" x="${fmtPct(x + BAR_LABEL_X_INSET_PCT)}" y="${y + BAR_LABEL_Y_OFFSET}">${escapeHtml(bar.name)}</text>`,
			);
			if (width >= BAR_LABEL_MIN_PCT_FOR_DURATION) {
				const duration = formatDurationUs(bar.endTs - bar.startTs);
				const reserve = bar.errored ? ERROR_ICON_RESERVE_PCT : 0;
				const durationX = x + width - BAR_LABEL_X_INSET_PCT - reserve;
				texts.push(
					`<text class="bar-label-dim" x="${fmtPct(durationX)}" y="${y + BAR_LABEL_Y_OFFSET}" text-anchor="end">${escapeHtml(duration)}</text>`,
				);
			}
		}
		if (bar.errored) {
			const iconX = x + width - ERROR_ICON_X_INSET;
			texts.push(
				`<text class="bar-error-icon" x="${fmtPct(Math.max(iconX, x + BAR_LABEL_X_INSET_PCT))}" y="${y + BAR_LABEL_Y_OFFSET}">⚠</text>`,
			);
		}
		if (bar.orphan) {
			const glyphX = x + width - BAR_LABEL_X_INSET_PCT;
			texts.push(
				`<text class="bar-orphan-glyph" x="${fmtPct(glyphX)}" y="${y + BAR_LABEL_Y_OFFSET}">⇥</text>`,
			);
		}
	}

	const svgHeight =
		layout.mainRows * ROW_HEIGHT_PX +
		(layout.trackRows > 0
			? TRACK_DIVIDER_GAP_PX +
				TRACK_LABEL_HEIGHT_PX +
				layout.trackRows * ROW_HEIGHT_PX
			: 0) +
		BAR_Y_OFFSET_PX;

	// Track divider + label (always render when there would be a track area).
	if (layout.trackRows > 0 || hasAnyTimerMarker(layout)) {
		const dividerY = layout.mainRows * ROW_HEIGHT_PX + TRACK_DIVIDER_GAP_PX / 2;
		shapes.push(
			`<line class="flame-track-divider" x1="0" y1="${dividerY}" x2="${VIEWBOX_WIDTH}" y2="${dividerY}"/>`,
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
	const segments: string[] = [];
	const ticks = RULER_TICK_COUNT;
	for (let i = 0; i < ticks; i++) {
		const frac = i / (ticks - 1);
		const ts = Math.round(totalDurationTs * frac);
		const label = formatDurationUs(ts);
		const xPct = frac * PERCENT_MULTIPLIER;
		let anchor = "middle";
		if (i === 0) {
			anchor = "start";
		} else if (i === ticks - 1) {
			anchor = "end";
		}
		segments.push(
			`<text class="flame-ruler-label" x="${fmtPct(xPct)}" y="12" text-anchor="${anchor}">${escapeHtml(label)}</text>`,
		);
	}
	return `<svg class="flame-ruler" width="100%" height="${RULER_HEIGHT_PX}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><line class="flame-ruler-tick" x1="0" y1="15" x2="100%" y2="15"/>${segments.join("")}</svg>`;
}

interface LegendPresence {
	readonly hasTrigger: boolean;
	readonly hasAction: boolean;
	readonly hasRest: boolean;
	readonly hasOrphan: boolean;
	readonly hasClearMarker: boolean;
	readonly hasCallMarker: boolean;
}

function detectLegendPresence(layout: Layout): LegendPresence {
	let hasTrigger = false;
	let hasAction = false;
	let hasRest = false;
	let hasOrphan = false;
	for (const bar of layout.bars) {
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
	let hasClearMarker = false;
	let hasCallMarker = false;
	for (const m of layout.markers) {
		const isTimerSet =
			m.kind === "system.call" && TIMER_REGISTRATION_NAMES.has(m.name);
		const isTimerClear =
			m.kind === "system.call" && TIMER_CLEAR_NAMES.has(m.name);
		if (isTimerClear) {
			hasClearMarker = true;
		} else if (!isTimerSet) {
			hasCallMarker = true;
		}
	}
	return {
		hasTrigger,
		hasAction,
		hasRest,
		hasOrphan,
		hasClearMarker,
		hasCallMarker,
	};
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
				fetch / timer / other
			</span>
		),
		presence.hasOrphan && (
			<span class="flame-legend-item">
				<span class="flame-legend-swatch flame-legend-swatch--orphan" />
				orphan (no terminal)
			</span>
		),
		presence.hasClearMarker && (
			<span class="flame-legend-item">
				<span class="flame-legend-glyph">×</span>
				timer cleared
			</span>
		),
		presence.hasCallMarker && (
			<span class="flame-legend-item">
				<span class="flame-legend-glyph">●</span>
				host call
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

function Metrics({ layout }: { layout: Layout }) {
	return (
		<>
			{layout.actionCount > 0 && (
				<span>
					<strong>{String(layout.actionCount)}</strong>{" "}
					{layout.actionCount === 1 ? "action" : "actions"}
				</span>
			)}
			{layout.systemCount > 0 && (
				<span>
					<strong>{String(layout.systemCount)}</strong>{" "}
					{layout.systemCount === 1 ? "host call" : "host calls"}
				</span>
			)}
			{layout.timerCount > 0 && (
				<span>
					<strong>{String(layout.timerCount)}</strong>{" "}
					{layout.timerCount === 1 ? "timer" : "timers"}
				</span>
			)}
		</>
	);
}

function hasAnyMetrics(layout: Layout): boolean {
	return (
		layout.actionCount > 0 || layout.systemCount > 0 || layout.timerCount > 0
	);
}

// Pulls the dispatching user's name out of the invocation's `trigger.request`
// event (`meta.dispatch.user.name`, stamped by the executor's widener).
// Returns an empty fragment when no name is present so the flamegraph header
// stays unadorned for trigger-source-backed invocations.
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

// Synthetic single-leaf `trigger.exception` invocation — no
// `trigger.request`, no frame, no paired bars to lay out. Render an instant
// marker carrying the failure cause so the author sees "imap.poll-failed:
// ECONNREFUSED" (or similar) without expanding further. Per
// `dashboard-list-view` spec "Single-leaf invocation flamegraph renders
// the leaf event".
function TriggerExceptionFragment({ event }: { event: InvocationEvent }) {
	// `event.name` carries the failure-category discriminator
	// (e.g. "imap.poll-failed"). Stage-specific payload (e.g. IMAP's
	// `stage`) lives under `event.input.{stage,…}` per the
	// `executor.fail` stamping contract.
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

function Flamegraph({ events }: { events: readonly InvocationEvent[] }) {
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

	const { svgShapes, svgTexts, svgHeight } = buildSvgPieces(layout);
	const ruler = renderRuler(layout.totalDurationTs);

	// The invocation card that wraps this flamegraph already surfaces the
	// workflow/trigger identity, started timestamp, duration and status
	// badge. The flamegraph header only adds what the card does not:
	// per-kind counts (actions/host calls/timers, suppressed when zero) and
	// the dispatching user's name when the fire was manual.
	const dispatcher = dispatchUserName(events);
	const showHeader = hasAnyMetrics(layout) || dispatcher !== undefined;

	const svg =
		`<svg class="flame-graph" width="100%" height="${svgHeight}" viewBox="0 0 ${VIEWBOX_WIDTH} ${svgHeight}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
		svgShapes +
		svgTexts +
		"</svg>";

	const eventsJson = JSON.stringify(events, bigintToNumber).replace(
		/</g,
		"\\u003c",
	);

	return (
		<div class="flame-fragment">
			{showHeader && (
				<div class="flame-header-metrics">
					<Metrics layout={layout} />
					{dispatcher && <TriggeredBy name={dispatcher} />}
				</div>
			)}
			<Legend presence={detectLegendPresence(layout)} />
			{raw(ruler)}
			<div class="flame-container">{raw(svg)}</div>
			<script type="application/json" class="flame-events">
				{raw(eventsJson)}
			</script>
		</div>
	);
}

// Compat shim — calls .toString() so c.html() accepts the result directly
// and html-invariants tests can `(await renderFlamegraph(...)).toString()`.
function renderFlamegraph(events: readonly InvocationEvent[]) {
	return (<Flamegraph events={events} />).toString();
}

export type { LaidOutBar, LaidOutConnector, LaidOutMarker, Layout };
export { Flamegraph, renderFlamegraph };
