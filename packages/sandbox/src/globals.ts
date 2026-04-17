import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSValueHandle } from "quickjs-wasi";
import type { Bridge } from "./bridge-factory.js";

function readPackageVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const candidate = resolve(dir, "package.json");
		if (existsSync(candidate)) {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
				name?: string;
				version?: string;
			};
			if (parsed.name === "@workflow-engine/sandbox" && parsed.version) {
				return parsed.version;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error(
		"@workflow-engine/sandbox: could not locate package.json for version",
	);
}

const PACKAGE_VERSION = readPackageVersion();

interface TimerCleanup {
	dispose(): void;
	clearActive(): void;
}

type TimerName = "setTimeout" | "setInterval";
type ClearName = "clearTimeout" | "clearInterval";

interface PendingTimer {
	cb: JSValueHandle;
	name: TimerName;
}

// HTML spec: timeout is a WebIDL `long` (ToInt32), then clamped to 0 if
// negative. Without this, host Node prints TimeoutNaN/Negative/Overflow
// warnings when guests pass NaN, <0, or >=2^31.
const INT32_MAX = 2_147_483_647;
function normalizeDelay(raw: number): number {
	if (!Number.isFinite(raw) || raw < 0 || raw > INT32_MAX) {
		return 0;
	}
	return Math.trunc(raw);
}

function setupGlobals(b: Bridge): TimerCleanup {
	setupConsole(b);
	return setupTimers(b);
}

function setupConsole(b: Bridge): void {
	const consoleObj = b.vm.newObject();
	for (const name of ["log", "info", "warn", "error", "debug"] as const) {
		b.sync(consoleObj, name, {
			method: `console.${name}`,
			args: [b.arg.json.rest],
			marshal: b.marshal.void,
			impl: () => {
				/* no-op: auto-log captures method + args */
			},
		});
	}
	b.vm.setProp(b.vm.global, "console", consoleObj);
	consoleObj.dispose();
}

// Timers bypass the bridge's b.sync / b.async wrappers because those cannot
// represent a callback-handle argument; instead they emit events manually via
// b.buildEvent / b.emit / b.pushRef / b.popRef. See the sandbox capability's
// "Timer event kinds" and "Safe globals — timers" requirements for the
// emission contract.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: registering all timer globals together is clearer than splitting
function setupTimers(b: Bridge): TimerCleanup {
	const pendingCallbacks = new Map<number, PendingTimer>();

	function emitEvent(
		kind:
			| "timer.set"
			| "timer.request"
			| "timer.response"
			| "timer.error"
			| "timer.clear",
		ref: number | null,
		name: TimerName | ClearName,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): number {
		const seq = b.nextSeq();
		const evt = b.buildEvent(kind, seq, ref, name, extra);
		if (evt) {
			b.emit(evt);
		}
		return seq;
	}

	function dumpSafe(handle: JSValueHandle): unknown {
		try {
			return b.vm.dump(handle);
		} catch {
			return;
		}
	}

	function runCallback(
		cb: JSValueHandle,
		numId: number,
		name: TimerName,
	): void {
		const reqSeq = emitEvent("timer.request", null, name, {
			input: { timerId: numId },
		});
		b.pushRef(reqSeq);
		try {
			const ret = b.vm.callFunction(cb, b.vm.undefined);
			const output = dumpSafe(ret);
			ret.dispose();
			emitEvent("timer.response", reqSeq, name, {
				input: { timerId: numId },
				...(output === undefined ? {} : { output }),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? (err.stack ?? "") : "";
			emitEvent("timer.error", reqSeq, name, {
				input: { timerId: numId },
				error: { message, stack },
			});
		} finally {
			b.popRef();
			b.vm.executePendingJobs();
		}
	}

	const setTimeoutFn = b.vm.newFunction(
		"setTimeout",
		(callbackHandle, delayHandle) => {
			const delay = normalizeDelay(delayHandle.toNumber());
			const cb = callbackHandle.dup();

			const id = setTimeout(() => {
				runCallback(cb, numId, "setTimeout");
				pendingCallbacks.delete(numId);
				cb.dispose();
			}, delay);

			const numId = Number(id);
			emitEvent("timer.set", b.currentRef(), "setTimeout", {
				input: { delay, timerId: numId },
			});
			pendingCallbacks.set(numId, { cb, name: "setTimeout" });
			return b.vm.newNumber(numId);
		},
	);
	b.vm.setProp(b.vm.global, "setTimeout", setTimeoutFn);
	setTimeoutFn.dispose();

	const clearTimeoutFn = b.vm.newFunction("clearTimeout", (idHandle) => {
		const id = idHandle.toNumber();
		const entry = pendingCallbacks.get(id);
		if (entry) {
			emitEvent("timer.clear", b.currentRef(), "clearTimeout", {
				input: { timerId: id },
			});
			clearTimeout(id);
			entry.cb.dispose();
			pendingCallbacks.delete(id);
		}
		return b.vm.undefined;
	});
	b.vm.setProp(b.vm.global, "clearTimeout", clearTimeoutFn);
	clearTimeoutFn.dispose();

	const setIntervalFn = b.vm.newFunction(
		"setInterval",
		(callbackHandle, delayHandle) => {
			const delay = normalizeDelay(delayHandle.toNumber());
			const cb = callbackHandle.dup();

			const id = setInterval(() => {
				runCallback(cb, numId, "setInterval");
			}, delay);

			const numId = Number(id);
			emitEvent("timer.set", b.currentRef(), "setInterval", {
				input: { delay, timerId: numId },
			});
			pendingCallbacks.set(numId, { cb, name: "setInterval" });
			return b.vm.newNumber(numId);
		},
	);
	b.vm.setProp(b.vm.global, "setInterval", setIntervalFn);
	setIntervalFn.dispose();

	const clearIntervalFn = b.vm.newFunction("clearInterval", (idHandle) => {
		const id = idHandle.toNumber();
		const entry = pendingCallbacks.get(id);
		if (entry) {
			emitEvent("timer.clear", b.currentRef(), "clearInterval", {
				input: { timerId: id },
			});
			clearInterval(id);
			entry.cb.dispose();
			pendingCallbacks.delete(id);
		}
		return b.vm.undefined;
	});
	b.vm.setProp(b.vm.global, "clearInterval", clearIntervalFn);
	clearIntervalFn.dispose();

	function clearActive(): void {
		for (const [id, entry] of pendingCallbacks) {
			const clearName: ClearName =
				entry.name === "setTimeout" ? "clearTimeout" : "clearInterval";
			emitEvent("timer.clear", null, clearName, {
				input: { timerId: id },
			});
			clearTimeout(id);
			clearInterval(id);
			entry.cb.dispose();
		}
		pendingCallbacks.clear();
	}

	return {
		dispose: clearActive,
		clearActive,
	};
}

// Three WinterCG Minimum Common API globals that libraries feature-detect.
// None carry host capability: self is identity, navigator exposes only a
// static version-stamped string, reportError is a partial shim that forwards
// to __reportError (installed via construction-time methods / per-run
// extraMethods). Documented in SECURITY.md §2.
const TRIVIAL_SHIMS = `(function() {
  globalThis.self = globalThis;
  globalThis.navigator = Object.freeze({
    userAgent: 'WorkflowEngine/${PACKAGE_VERSION}'
  });
})();`;

const REPORT_ERROR_SHIM = `(function() {
  // Each property read is try/guarded so a throwing getter (e.g.
  // \`Object.defineProperty(obj, 'message', { get() { throw ... } })\`) on
  // the reported value doesn't itself escape from reportError() into guest
  // code. On any field-read failure we substitute a sentinel string.
  function readField(value, key) {
    try {
      var v = value[key];
      return typeof v === 'string' ? v : undefined;
    } catch (e) {
      return undefined;
    }
  }
  function readCause(value) {
    try {
      return value.cause;
    } catch (e) {
      return undefined;
    }
  }
  function serialize(value, seen) {
    if (value == null) return { name: 'Error', message: String(value) };
    if (typeof value !== 'object') {
      return { name: 'Error', message: String(value) };
    }
    if (seen.has(value)) return { name: 'Error', message: '[circular]' };
    seen.add(value);
    var name = readField(value, 'name');
    var message = readField(value, 'message');
    var stack = readField(value, 'stack');
    var out = {
      name: name == null ? 'Error' : name,
      message: message == null ? safeStringify(value) : message,
    };
    if (stack != null) out.stack = stack;
    var cause = readCause(value);
    if (cause !== undefined) out.cause = serialize(cause, seen);
    return out;
  }
  function safeStringify(value) {
    try { return String(value); } catch (e) { return '[unstringifiable]'; }
  }
  globalThis.reportError = function(err) {
    try {
      __reportError(serialize(err, new Set()));
    } catch (e) { /* never propagate into guest */ }
  };
})();`;

// JS shim that wraps crypto.subtle methods so they return Promises, matching
// the standard WebCrypto spec. The WASM crypto extension returns synchronously
// — this shim runs inside the VM to wrap each method.
const CRYPTO_PROMISE_SHIM = `(function() {
  var _subtle = crypto.subtle;
  var _methods = ['digest','importKey','exportKey','sign','verify','encrypt','decrypt','generateKey','deriveBits','deriveKey','wrapKey','unwrapKey'];
  for (var i = 0; i < _methods.length; i++) {
    var m = _methods[i];
    var orig = _subtle[m].bind(_subtle);
    _subtle[m] = (function(fn) {
      return function() {
        try { return Promise.resolve(fn.apply(null, arguments)); }
        catch (e) { return Promise.reject(e); }
      };
    })(orig);
  }
})();`;

// JS shim that provides a standard fetch() implementation on top of the
// host-installed __hostFetch. Must be evaluated AFTER bridgeHostFetch has
// installed __hostFetch on the global.
const FETCH_SHIM = `(function() {
  function normalizeHeaders(init) {
    if (!init) return {};
    if (typeof Headers !== 'undefined' && init instanceof Headers) {
      var obj = {};
      init.forEach(function(v, k) { obj[k] = v; });
      return obj;
    }
    if (Array.isArray(init)) return Object.fromEntries(init);
    return Object.assign({}, init);
  }
  function normalizeBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return new TextDecoder().decode(body);
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    return String(body);
  }
  function makeResponse(hostRes) {
    var status = hostRes.status;
    var headers = new Headers(hostRes.headers || {});
    var body = hostRes.body == null ? '' : String(hostRes.body);
    var consumed = false;
    function consume() {
      if (consumed) throw new TypeError('Body has already been consumed');
      consumed = true;
      return body;
    }
    return {
      status: status,
      statusText: hostRes.statusText || '',
      ok: status >= 200 && status < 300,
      headers: headers,
      url: hostRes.url || '',
      redirected: false,
      type: 'basic',
      text: function() { return Promise.resolve(consume()); },
      json: function() {
        try { return Promise.resolve(JSON.parse(consume())); }
        catch (e) { return Promise.reject(e); }
      },
      arrayBuffer: function() {
        return Promise.resolve(new TextEncoder().encode(consume()).buffer);
      },
    };
  }
  function fetch(input, init) {
    var url = typeof input === 'string' ? input : String(input);
    var method = (init && init.method) || 'GET';
    var headers = normalizeHeaders(init && init.headers);
    var body = normalizeBody(init && init.body);
    return __hostFetch(method, url, headers, body).then(makeResponse);
  }
  // Lock fetch down so guest code cannot reassign it to point somewhere
  // else. The shim routes through __hostFetch (which the host controls),
  // so a rogue override could only break the workflow's own fetch calls,
  // but freezing the binding removes an avenue for accidental confusion.
  Object.defineProperty(globalThis, 'fetch', {
    value: fetch,
    writable: false,
    configurable: false,
    enumerable: true,
  });
})();`;

export type { TimerCleanup };
export {
	CRYPTO_PROMISE_SHIM,
	FETCH_SHIM,
	REPORT_ERROR_SHIM,
	setupGlobals,
	TRIVIAL_SHIMS,
};
