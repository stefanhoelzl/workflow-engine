// EventTarget + Event + ErrorEvent + AbortController + AbortSignal.
//
// EventTarget and Event are provided by `event-target-shim` (v6, pure JS).
// ErrorEvent, AbortSignal, AbortController are hand-written on top of the
// shim's subclass path (verified to work end-to-end in QuickJS).
//
// DOMException is already native (quickjs-wasi WASM extension) — we use it
// as-is for default abort / timeout reasons.
//
// globalThis is installed as an EventTarget via hybrid H:
//   1. Object.setPrototypeOf(globalThis, EventTarget.prototype)
//   2. non-enumerable own-property bound methods, backed by a private
//      EventTarget instance (the shim keys its listener state by `this`
//      in a module-private WeakMap, so globalThis cannot be retrofitted
//      as an instance through the constructor path).

import { Event, EventTarget } from "event-target-shim";

class CustomEvent<
	T = unknown,
> extends (Event as unknown as typeof globalThis.Event) {
	readonly detail: T;

	constructor(
		type: string,
		init: {
			detail?: T;
			bubbles?: boolean;
			cancelable?: boolean;
			composed?: boolean;
		} = {},
	) {
		super(type, init);
		this.detail = (init.detail ?? null) as T;
	}
}

class ErrorEvent extends (Event as unknown as typeof globalThis.Event) {
	readonly message: string;
	readonly filename: string;
	readonly lineno: number;
	readonly colno: number;
	readonly error: unknown;

	constructor(
		type: string,
		init: {
			message?: string;
			filename?: string;
			lineno?: number;
			colno?: number;
			error?: unknown;
			bubbles?: boolean;
			cancelable?: boolean;
			composed?: boolean;
		} = {},
	) {
		super(type, init);
		this.message = init.message ?? "";
		this.filename = init.filename ?? "";
		this.lineno = init.lineno ?? 0;
		this.colno = init.colno ?? 0;
		this.error = init.error === undefined ? null : init.error;
	}
}

// Module-private reason storage — AbortSignal.reason is a getter on a
// WeakMap so `aborted` and `reason` stay in sync without relying on
// instance-property observation ordering.
const ABORT_REASONS = new WeakMap<AbortSignal, unknown>();

// Event-handler IDL attribute backing store. Shared so TaskSignal and any other
// AbortSignal subclass installed later (e.g. via scheduler-polyfill) can reuse
// the same onabort accessor without re-implementing the slot machinery.
const EVENT_HANDLERS = new WeakMap<
	object,
	Map<string, { handler: unknown; listener: EventListener | null }>
>();

function defineEventHandler(proto: object, eventName: string): void {
	Object.defineProperty(proto, `on${eventName}`, {
		configurable: true,
		enumerable: true,
		get(this: object): unknown {
			return EVENT_HANDLERS.get(this)?.get(eventName)?.handler ?? null;
		},
		set(this: object, value: unknown): void {
			let perTarget = EVENT_HANDLERS.get(this);
			if (!perTarget) {
				perTarget = new Map();
				EVENT_HANDLERS.set(this, perTarget);
			}
			let entry = perTarget.get(eventName);
			if (!entry) {
				entry = { handler: null, listener: null };
				perTarget.set(eventName, entry);
			}
			if (entry.listener) {
				(
					this as unknown as {
						removeEventListener: (t: string, l: EventListener) => void;
					}
				).removeEventListener(eventName, entry.listener);
				entry.listener = null;
			}
			const handler = typeof value === "function" ? value : null;
			entry.handler = handler;
			if (handler) {
				const listener: EventListener = (event: Event): void => {
					const h = EVENT_HANDLERS.get(this)?.get(eventName)?.handler;
					if (typeof h === "function") {
						(h as (this: object, ev: Event) => unknown).call(this, event);
					}
				};
				entry.listener = listener;
				(
					this as unknown as {
						addEventListener: (t: string, l: EventListener) => void;
					}
				).addEventListener(eventName, listener);
			}
		},
	});
}

class AbortSignal extends (EventTarget as unknown as typeof globalThis.EventTarget) {
	get aborted(): boolean {
		return ABORT_REASONS.has(this);
	}
	get reason(): unknown {
		return ABORT_REASONS.get(this);
	}
	throwIfAborted(): void {
		if (this.aborted) {
			throw this.reason;
		}
	}

	static abort(reason?: unknown): AbortSignal {
		const c = new AbortController();
		c.abort(reason);
		return c.signal;
	}

	static timeout(ms: number): AbortSignal {
		const c = new AbortController();
		setTimeout(() => {
			c.abort(
				new (
					globalThis as unknown as {
						DOMException: new (message: string, name: string) => Error;
					}
				).DOMException("signal timed out", "TimeoutError"),
			);
		}, ms);
		return c.signal;
	}

	static any(signals: Iterable<AbortSignal>): AbortSignal {
		const c = new AbortController();
		for (const s of signals) {
			if (s.aborted) {
				c.abort(s.reason);
				return c.signal;
			}
			s.addEventListener(
				"abort",
				() => {
					c.abort(s.reason);
				},
				{ once: true },
			);
		}
		return c.signal;
	}
}

class AbortController {
	readonly signal: AbortSignal;
	constructor() {
		this.signal = new AbortSignal();
	}
	abort(reason?: unknown): void {
		if (this.signal.aborted) {
			return;
		}
		const actual =
			reason === undefined
				? new (
						globalThis as unknown as {
							DOMException: new (message: string, name: string) => Error;
						}
					).DOMException("signal is aborted without reason", "AbortError")
				: reason;
		ABORT_REASONS.set(this.signal, actual);
		this.signal.dispatchEvent(new Event("abort"));
	}
}

// AbortSignal.onabort — event-handler IDL attribute. WPT `dom/abort/event.any.js`
// installs handlers via `signal.onabort = fn`; without a setter the handler
// never fires and timer-driven tests hit the watchdog.
defineEventHandler(AbortSignal.prototype, "abort");

// ───── Install on globalThis (hybrid H) ─────

// 1. Prototype chain — gives us `globalThis instanceof EventTarget === true`
Object.setPrototypeOf(
	globalThis,
	(EventTarget as unknown as { prototype: object }).prototype,
);

// 2. Non-enumerable bound methods — gives us working
//    self.addEventListener / .removeEventListener / .dispatchEvent.
//    Can't call the shim's constructor on globalThis (its internal
//    WeakMap keys by `this` and the Babel classCallCheck blocks
//    retargeting), so we delegate to a private EventTarget instance.
const _globalET = new EventTarget();
for (const method of [
	"addEventListener",
	"removeEventListener",
	"dispatchEvent",
] as const) {
	const bound = (_globalET[method] as (...args: unknown[]) => unknown).bind(
		_globalET,
	);
	Object.defineProperty(globalThis, method, {
		value: bound,
		writable: true,
		configurable: true,
		enumerable: false, // keep Object.keys(globalThis) clean
	});
}

// 3. Publish classes as writable/configurable own-properties
for (const [name, value] of [
	["EventTarget", EventTarget],
	["Event", Event],
	["CustomEvent", CustomEvent],
	["ErrorEvent", ErrorEvent],
	["AbortController", AbortController],
	["AbortSignal", AbortSignal],
] as const) {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}
