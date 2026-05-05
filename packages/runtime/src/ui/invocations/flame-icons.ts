// Lucide-derived icon paths for the flamegraph SSR layer. Paths are emitted
// into a single <defs> sprite (one <symbol> per icon) at the top of every
// flamegraph SVG, then referenced by <use href="#fi-<name>" .../> for bar
// gutters and leaf markers. Keeps the wire format compact (each glyph cited
// many times shares one definition) and the runtime CSP-clean (no external
// icon font, no inline scripts).
//
// Path data is transcribed from lucide.dev at the matching icon name.
// Stroke attributes live on the symbol's <g> wrapper so each <use> just
// inherits them; colour comes from `currentColor` (set per-context via the
// surrounding bar/marker class).

const ICON_PATHS: Record<string, string> = {
	// timer family
	timer:
		'<path d="M10 2h4"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
	"timer-off":
		'<path d="M10 2h4"/><path d="M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7"/><path d="M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2"/><path d="m2 2 20 20"/><path d="M12 12v-2"/>',
	// console
	"scroll-text":
		'<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
	// random
	dices:
		'<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',
	// crypto
	"key-round":
		'<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
	// performance
	gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
	// scheduler.postTask
	"clock-plus":
		'<path d="M12 6v6l3.644 1.822"/><path d="M16 19h6"/><path d="M19 16v6"/><path d="M21.92 13.267A10 10 0 1 0 10.73 21.92"/>',
	// wasi.clock_time_get
	clock:
		'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
	// wasi.fd_write
	"pen-line":
		'<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
	// sendMail / imap trigger
	mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
	// system.exception
	"triangle-alert":
		'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	// system.exhaustion
	"circle-x":
		'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
	// fallback
	"circle-question-mark":
		'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
	// fetch + http trigger
	globe:
		'<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a14.5 14.5 0 0 1 0 20 14.5 14.5 0 0 1 0-20"/>',
	// executeSql
	"database-zap":
		'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 15 20.97"/><path d="M21 5V8"/><path d="M21 12L18 17h4l-3 5"/><path d="M3 12A9 3 0 0 0 14.5 14.87"/>',
	// queue.put
	"layer-plus":
		'<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M19 16v6"/><path d="M16 19h6"/>',
	// queue.get
	"layer-minus":
		'<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M16 19h6"/>',
	// action.*
	"monitor-cog":
		'<path d="M12 17v4"/><path d="m15.2 4.9-.9-.4"/><path d="m15.2 7.1-.9.4"/><path d="m16.9 3.2-.4-.9"/><path d="m16.9 8.8-.4.9"/><path d="m19.5 2.3-.4.9"/><path d="m19.5 9.7-.4-.9"/><path d="m21.7 4.5-.9.4"/><path d="m21.7 7.5-.9-.4"/><path d="M22 13v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/><path d="M8 21h8"/><circle cx="18" cy="6" r="3"/>',
	// trigger-kind icons (mirror sidebar)
	zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
	user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
	plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
	upload:
		'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
};

// Build the sprite block for the SVG <defs>. A single <g> wrapper carries
// the stroke attributes so individual paths stay terse.
function flameIconSprite(): string {
	const symbols: string[] = [];
	for (const [name, paths] of Object.entries(ICON_PATHS)) {
		// `overflow` defaults to hidden on <symbol>, which clips any
		// stray path geometry to the 24×24 box. With overflow="visible"
		// (the previous setting) icons whose Lucide paths extend slightly
		// past 0..24 (e.g. the timer / clock-plus glyphs) bled above their
		// host bar and got clipped by the surrounding canvas instead.
		// Stroke 2.5 (vs Lucide's 2) keeps detail readable at the 14×14 px
		// render size used on the marker row and bar gutters.
		symbols.push(
			`<symbol id="fi-${name}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths}</g></symbol>`,
		);
	}
	return symbols.join("");
}

// Marker-name → icon-id resolution. Returns null when the name has no
// distinct glyph; caller should fall back to "circle-question-mark".
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat dispatch table — every branch is a single string comparison or prefix test, structured as a switch-like ladder for readability.
function iconForMarker(kind: string, name: string): string {
	if (kind === "system.exception") {
		return "triangle-alert";
	}
	if (kind === "system.exhaustion") {
		return "circle-x";
	}
	if (kind !== "system.call") {
		return "circle-question-mark";
	}
	if (name === "setTimeout" || name === "setInterval") {
		return "timer";
	}
	if (name === "clearTimeout" || name === "clearInterval") {
		return "timer-off";
	}
	if (name.startsWith("console.")) {
		return "scroll-text";
	}
	if (name === "randomUUID" || name === "wasi.random_get") {
		return "dices";
	}
	if (name.startsWith("crypto.subtle.") || name.startsWith("crypto.")) {
		return "key-round";
	}
	if (name.startsWith("performance.")) {
		return "gauge";
	}
	if (name === "scheduler.postTask") {
		return "clock-plus";
	}
	if (name === "wasi.clock_time_get") {
		return "clock";
	}
	if (name === "wasi.fd_write") {
		return "pen-line";
	}
	if (name === "sendMail") {
		return "mail";
	}
	return "circle-question-mark";
}

// Bar-name → icon-id resolution. `name` is the event-recorded bar name
// (e.g. "fetch GET https://...", "executeSql db.example.com/foo",
// "queue.put", an action identifier, a trigger export name). `kind` is the
// classified BarKind so action/trigger get their dedicated icons without
// regex on the name. `triggerKind` (when present) selects the per-kind
// trigger glyph.
function iconForBar(
	kind: "trigger" | "action" | "rest",
	name: string,
	triggerKind: string | undefined,
): string | null {
	if (kind === "trigger") {
		switch (triggerKind) {
			case "cron":
				return "clock";
			case "http":
				return "globe";
			case "manual":
				return "user";
			case "imap":
				return "mail";
			case "ws":
				return "plug";
			case "upload":
				return "upload";
			default:
				return "zap";
		}
	}
	if (kind === "action") {
		return "monitor-cog";
	}
	if (name.startsWith("fetch ") || name === "fetch") {
		return "globe";
	}
	if (name.startsWith("executeSql")) {
		return "database-zap";
	}
	if (name === "queue.put") {
		return "layer-plus";
	}
	if (name === "queue.get") {
		return "layer-minus";
	}
	return null;
}

// Inline-label shortener. For verbose names where the head conveys the
// operation (fetch / executeSql), surface only the head inline; the full
// METHOD-URL / host-db form lives in the SVG <title> tooltip per the
// "fetch shows POST on hover" rule.
function shortLabelFor(name: string): string {
	if (name.startsWith("fetch ")) {
		return "fetch";
	}
	if (name.startsWith("executeSql ")) {
		return "executeSql";
	}
	return name;
}

export { flameIconSprite, iconForBar, iconForMarker, shortLabelFor };
