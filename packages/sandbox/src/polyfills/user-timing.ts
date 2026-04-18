// User Timing Level 3 — pure-JS polyfill on top of the native `performance.now`
// provided by the quickjs-wasi monotonic-clock extension. PerformanceObserver
// is out of scope; the timeline buffers are in-process arrays.

interface MarkOptions {
	startTime?: number;
	detail?: unknown;
}

interface MeasureOptions {
	start?: number | string;
	end?: number | string;
	duration?: number;
	detail?: unknown;
}

const _performance = globalThis.performance as {
	now: () => number;
};

const _structuredClone = globalThis.structuredClone as (v: unknown) => unknown;
const _DOMException = (
	globalThis as unknown as {
		DOMException: new (message: string, name: string) => Error;
	}
).DOMException;

class PerformanceEntry {
	readonly name: string;
	readonly entryType: string;
	readonly startTime: number;
	readonly duration: number;

	constructor(
		name: string,
		entryType: string,
		startTime: number,
		duration: number,
	) {
		this.name = String(name);
		this.entryType = entryType;
		this.startTime = startTime;
		this.duration = duration;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			entryType: this.entryType,
			startTime: this.startTime,
			duration: this.duration,
		};
	}

	get [Symbol.toStringTag](): string {
		return "PerformanceEntry";
	}
}

function validateMarkOptions(options: unknown): MarkOptions {
	if (options === undefined || options === null) {
		return {};
	}
	if (typeof options !== "object") {
		throw new TypeError("PerformanceMark options must be an object");
	}
	const opts = options as MarkOptions;
	if (
		opts.startTime !== undefined &&
		(typeof opts.startTime !== "number" || opts.startTime < 0)
	) {
		throw new TypeError("startTime must be a non-negative number");
	}
	return opts;
}

class PerformanceMark extends PerformanceEntry {
	readonly detail: unknown;

	constructor(name: string, options?: MarkOptions) {
		const opts = validateMarkOptions(options);
		const startTime =
			opts.startTime === undefined ? _performance.now() : opts.startTime;
		super(name, "mark", startTime, 0);
		this.detail =
			opts.detail === undefined || opts.detail === null
				? null
				: _structuredClone(opts.detail);
	}

	get [Symbol.toStringTag](): string {
		return "PerformanceMark";
	}
}

class PerformanceMeasure extends PerformanceEntry {
	readonly detail: unknown;

	constructor(
		name: string,
		startTime: number,
		duration: number,
		detail: unknown,
	) {
		super(name, "measure", startTime, duration);
		this.detail = detail;
	}

	get [Symbol.toStringTag](): string {
		return "PerformanceMeasure";
	}
}

const marks: PerformanceMark[] = [];
const measures: PerformanceMeasure[] = [];

function mark(name: string, options?: MarkOptions): PerformanceMark {
	const entry = new PerformanceMark(name, options);
	marks.push(entry);
	return entry;
}

function convertMarkToTimestamp(value: number | string): number {
	if (typeof value === "number") {
		if (value < 0) {
			throw new TypeError("mark timestamp cannot be negative");
		}
		return value;
	}
	if (typeof value === "string") {
		for (let i = marks.length - 1; i >= 0; i--) {
			const m = marks[i];
			if (m !== undefined && m.name === value) {
				return m.startTime;
			}
		}
		throw new _DOMException(
			`The mark '${value}' does not exist.`,
			"SyntaxError",
		);
	}
	throw new TypeError("mark reference must be a string or number");
}

interface ResolvedMeasure {
	startTime: number;
	endTime: number;
	detail: unknown;
}

function resolveMeasureOptions(opts: MeasureOptions): ResolvedMeasure {
	const hasStart = opts.start !== undefined;
	const hasEnd = opts.end !== undefined;
	const hasDuration = opts.duration !== undefined;

	if (hasDuration && hasStart && hasEnd) {
		throw new TypeError("duration cannot be provided with both start and end");
	}
	if (hasDuration && !hasStart && !hasEnd) {
		throw new TypeError("duration requires either start or end to be provided");
	}

	const startRef = opts.start as number | string;
	const endRef = opts.end as number | string;
	const dur = opts.duration as number;

	let endTime: number;
	if (hasEnd) {
		endTime = convertMarkToTimestamp(endRef);
	} else if (hasStart && hasDuration) {
		endTime = convertMarkToTimestamp(startRef) + dur;
	} else {
		endTime = _performance.now();
	}

	let startTime: number;
	if (hasStart) {
		startTime = convertMarkToTimestamp(startRef);
	} else if (hasEnd && hasDuration) {
		startTime = convertMarkToTimestamp(endRef) - dur;
	} else {
		startTime = 0;
	}

	const detail =
		opts.detail === undefined || opts.detail === null
			? null
			: _structuredClone(opts.detail);
	return { startTime, endTime, detail };
}

function resolveMeasurePositional(
	startOrOptions: string | number | undefined,
	endMark: string | number | undefined,
): ResolvedMeasure {
	const endTime =
		endMark === undefined
			? _performance.now()
			: convertMarkToTimestamp(endMark);
	const startTime =
		startOrOptions === undefined ? 0 : convertMarkToTimestamp(startOrOptions);
	return { startTime, endTime, detail: null };
}

function measure(
	name: string,
	startOrOptions?: string | number | MeasureOptions,
	endMark?: string | number,
): PerformanceMeasure {
	const isOptions =
		typeof startOrOptions === "object" && startOrOptions !== null;
	let resolved: ResolvedMeasure;
	if (isOptions) {
		if (endMark !== undefined) {
			throw new TypeError(
				"endMark must not be provided when using options dictionary",
			);
		}
		resolved = resolveMeasureOptions(startOrOptions as MeasureOptions);
	} else {
		resolved = resolveMeasurePositional(
			startOrOptions as string | number | undefined,
			endMark,
		);
	}
	const entry = new PerformanceMeasure(
		name,
		resolved.startTime,
		resolved.endTime - resolved.startTime,
		resolved.detail,
	);
	measures.push(entry);
	return entry;
}

function clearMarks(name?: string): void {
	if (name === undefined) {
		marks.length = 0;
		return;
	}
	for (let i = marks.length - 1; i >= 0; i--) {
		if (marks[i]?.name === name) {
			marks.splice(i, 1);
		}
	}
}

function clearMeasures(name?: string): void {
	if (name === undefined) {
		measures.length = 0;
		return;
	}
	for (let i = measures.length - 1; i >= 0; i--) {
		if (measures[i]?.name === name) {
			measures.splice(i, 1);
		}
	}
}

function getEntries(): PerformanceEntry[] {
	return [...marks, ...measures];
}

function getEntriesByType(type: string): PerformanceEntry[] {
	if (type === "mark") {
		return marks.slice();
	}
	if (type === "measure") {
		return measures.slice();
	}
	return [];
}

function getEntriesByName(name: string, type?: string): PerformanceEntry[] {
	if (type === "mark") {
		return marks.filter((e) => e.name === name);
	}
	if (type === "measure") {
		return measures.filter((e) => e.name === name);
	}
	const out: PerformanceEntry[] = [];
	for (const m of marks) {
		if (m.name === name) {
			out.push(m);
		}
	}
	for (const m of measures) {
		if (m.name === name) {
			out.push(m);
		}
	}
	return out;
}

for (const [name, value] of [
	["mark", mark],
	["measure", measure],
	["clearMarks", clearMarks],
	["clearMeasures", clearMeasures],
	["getEntries", getEntries],
	["getEntriesByType", getEntriesByType],
	// biome-ignore lint/security/noSecrets: false positive — Web Performance API method name
	["getEntriesByName", getEntriesByName],
] as const) {
	Object.defineProperty(_performance, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}

for (const [name, value] of [
	["PerformanceEntry", PerformanceEntry],
	["PerformanceMark", PerformanceMark],
	["PerformanceMeasure", PerformanceMeasure],
] as const) {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}
