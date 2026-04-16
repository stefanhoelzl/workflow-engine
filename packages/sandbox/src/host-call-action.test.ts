// Tests for the `__hostCallAction(name, input)` host-bridge convention.
//
// The sandbox package does NOT hardcode `__hostCallAction` as a built-in
// global. It is a convention the runtime follows: the runtime passes its
// dispatcher as `methods.__hostCallAction` at sandbox construction time.
// These tests stand up a stub dispatcher that mimics the Phase-4 runtime
// (manifest lookup, Zod-like input/output validation, handler dispatch,
// error propagation) and assert end-to-end semantics across the bridge.

import { describe, expect, it } from "vitest";
import type { MethodMap } from "./index.js";
import { sandbox } from "./index.js";

// --- Test helpers ---------------------------------------------------------

interface ZodLikeIssue {
	path: (string | number)[];
	message: string;
}

// A stub "Zod-like" validator. Throws a ValidationError carrying a structured
// `issues` array, matching the shape the runtime will produce with Zod v4
// (`.issues: [{ path, message }, ...]`).
function makeValidator<T>(
	predicate: (value: unknown) => value is T,
	buildIssues: (value: unknown) => ZodLikeIssue[],
): (value: unknown) => T {
	return (value: unknown) => {
		if (predicate(value)) {
			return value;
		}
		const err = new Error("validation_failed") as Error & {
			issues: ZodLikeIssue[];
		};
		err.name = "ZodError";
		err.issues = buildIssues(value);
		throw err;
	};
}

interface StubAction {
	input: (value: unknown) => unknown;
	output: (value: unknown) => unknown;
	handler: (input: unknown) => Promise<unknown>;
}

// Build the dispatcher the runtime will ship in Phase 4. The dispatcher:
//   1. Looks up the action in the manifest (throws on unknown name).
//   2. Validates input (throws validation error — preserves `issues`).
//   3. Invokes the handler (re-throws any handler error).
//   4. Validates output (throws validation error).
//   5. Returns the validated output to the caller.
function buildDispatcher(actions: Record<string, StubAction>) {
	return async function __hostCallAction(...args: unknown[]): Promise<unknown> {
		const [name, input] = args as [string, unknown];
		const action = actions[name];
		if (!action) {
			throw new Error(`action "${name}" is not declared in the manifest`);
		}
		const validInput = action.input(input);
		const output = await action.handler(validInput);
		return action.output(output);
	};
}

function isNumber(v: unknown): v is number {
	return typeof v === "number";
}

function isString(v: unknown): v is string {
	return typeof v === "string";
}

function isObjectWith<K extends string>(
	key: K,
	predicate: (v: unknown) => boolean,
): (v: unknown) => v is Record<K, unknown> {
	return (v: unknown): v is Record<K, unknown> =>
		typeof v === "object" &&
		v !== null &&
		key in v &&
		predicate((v as Record<string, unknown>)[key]);
}

const MISSING_GLOBAL_MESSAGE_RE = /__hostCallAction|not defined|not a function/;
const MISSING_GLOBAL_NAME_RE = /ReferenceError|TypeError|Error/;

function collectTypes(value: unknown): string[] {
	const types: string[] = [typeof value];
	if (value && typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) {
			types.push(typeof v);
		}
	}
	return types;
}

function anyReceivedCarriesNonDataType(
	received: unknown[],
	forbidden: ReadonlySet<string>,
): boolean {
	for (const args of received) {
		for (const arg of args as unknown[]) {
			for (const t of collectTypes(arg)) {
				if (forbidden.has(t)) {
					return true;
				}
			}
		}
	}
	return false;
}

// --- Tests ----------------------------------------------------------------

describe("__hostCallAction: round-trip", () => {
	it("guest call dispatches in same sandbox and returns validated output", async () => {
		const dispatcher = buildDispatcher({
			double: {
				input: makeValidator(isObjectWith("x", isNumber), () => [
					{ path: ["x"], message: "expected number" },
				]),
				output: makeValidator(isNumber, () => [
					{ path: [], message: "expected number" },
				]),
				handler: async (input: unknown) => {
					const { x } = input as { x: number };
					return x * 2;
				},
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				return await __hostCallAction("double", { x: 21 });
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toBe(42);
			}
		} finally {
			sb.dispose();
		}
	});

	it("action can call another action through the same bridge in one trigger invocation", async () => {
		// Simulates D11: a handler calling `await other(input)` compiles to
		// `__hostCallAction("other", input)`. All calls share the same
		// QuickJS context (same sandbox, sequential in this test).
		const dispatcher = buildDispatcher({
			increment: {
				input: (v) => v,
				output: (v) => v,
				handler: async (input: unknown) => (input as number) + 1,
			},
			incrementTwice: {
				input: (v) => v,
				output: (v) => v,
				handler: async () => {
					// Shouldn't reach: dispatcher invocations are driven by the guest.
					throw new Error("unreachable");
				},
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				const a = await __hostCallAction("increment", 1);
				const b = await __hostCallAction("increment", a);
				return b;
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toBe(3);
			}
		} finally {
			sb.dispose();
		}
	});
});

describe("__hostCallAction: error propagation preserves structure", () => {
	it("input validation error rethrows into guest with issues preserved", async () => {
		const dispatcher = buildDispatcher({
			strictNum: {
				input: makeValidator(isNumber, (v) => [
					{ path: [], message: `expected number, got ${typeof v}` },
				]),
				output: (v) => v,
				handler: async (v) => v,
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					await __hostCallAction("strictNum", "not a number");
					return { ok: true };
				} catch (err) {
					return {
						ok: false,
						name: err.name,
						message: err.message,
						issues: err.issues,
					};
				}
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toEqual({
					ok: false,
					name: "ZodError",
					message: "validation_failed",
					issues: [{ path: [], message: "expected number, got string" }],
				});
			}
		} finally {
			sb.dispose();
		}
	});

	it("output validation error rethrows into guest with issues preserved", async () => {
		const dispatcher = buildDispatcher({
			echoString: {
				input: (v) => v,
				output: makeValidator(isString, () => [
					{ path: [], message: "expected string output" },
				]),
				handler: async () => 42,
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					await __hostCallAction("echoString", null);
					return { ok: true };
				} catch (err) {
					return {
						ok: false,
						name: err.name,
						issues: err.issues,
					};
				}
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toEqual({
					ok: false,
					name: "ZodError",
					issues: [{ path: [], message: "expected string output" }],
				});
			}
		} finally {
			sb.dispose();
		}
	});

	it("handler-thrown error serializes and rethrows into guest with message + stack preserved", async () => {
		const dispatcher = buildDispatcher({
			explode: {
				input: (v) => v,
				output: (v) => v,
				handler: async () => {
					const err = new Error("boom") as Error & { code?: string };
					err.code = "E_BOOM";
					throw err;
				},
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					await __hostCallAction("explode", {});
					return { ok: true };
				} catch (err) {
					return {
						ok: false,
						name: err.name,
						message: err.message,
						code: err.code,
						hasStack: typeof err.stack === "string" && err.stack.length > 0,
					};
				}
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toMatchObject({
					ok: false,
					name: "Error",
					message: "boom",
					code: "E_BOOM",
					hasStack: true,
				});
			}
		} finally {
			sb.dispose();
		}
	});

	it("multiple issues in a Zod-shaped error are all preserved", async () => {
		const dispatcher = buildDispatcher({
			twoFields: {
				input: makeValidator(
					(v): v is { a: string; b: number } => false,
					() => [
						{ path: ["a"], message: "a must be string" },
						{ path: ["b"], message: "b must be number" },
					],
				),
				output: (v) => v,
				handler: async (v) => v,
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					await __hostCallAction("twoFields", {});
				} catch (err) {
					return err.issues;
				}
				return null;
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toEqual([
					{ path: ["a"], message: "a must be string" },
					{ path: ["b"], message: "b must be number" },
				]);
			}
		} finally {
			sb.dispose();
		}
	});
});

describe("__hostCallAction: unknown names + bad payloads", () => {
	it("unknown action name propagates dispatcher error into guest", async () => {
		const dispatcher = buildDispatcher({});

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					await __hostCallAction("missing", {});
				} catch (err) {
					return { message: err.message };
				}
				return null;
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toEqual({
					message: 'action "missing" is not declared in the manifest',
				});
			}
		} finally {
			sb.dispose();
		}
	});

	it("non-JSON-serializable input (function) fails at the bridge", async () => {
		// QuickJS's JSON.stringify on a function returns undefined for the
		// whole value when the function is passed as the top-level arg.
		// When nested inside an object, the function key is dropped. Either
		// way, a function value cannot cross the bridge as data.
		const received: unknown[] = [];
		const dispatcher = async (...args: unknown[]): Promise<unknown> => {
			received.push(args);
			return null;
		};

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					const fn = () => 42;
					await __hostCallAction("anyName", fn);
					return { ok: true, receivedFn: "reached" };
				} catch (err) {
					return { ok: false, message: err.message };
				}
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			// The bridge drops the function payload: the dispatcher either
			// never sees a useful value or the call resolves with a
			// null-like marshalled input. Either way, the function body
			// does not cross the boundary.
			expect(
				anyReceivedCarriesNonDataType(received, new Set(["function"])),
			).toBe(false);
		} finally {
			sb.dispose();
		}
	});

	it("non-JSON-serializable input (Symbol) is dropped by JSON marshaling", async () => {
		const received: unknown[] = [];
		const dispatcher = async (...args: unknown[]): Promise<unknown> => {
			received.push(args);
			return null;
		};

		const sb = await sandbox(
			`export default async (ctx) => {
				try {
					const sym = Symbol("nope");
					await __hostCallAction("anyName", { s: sym });
					return { ok: true };
				} catch (err) {
					return { ok: false, message: err.message };
				}
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			// Symbol values are dropped by JSON.stringify; the payload
			// arrives at the host with the key missing (or the value
			// becomes undefined, which cannot be in JSON).
			expect(anyReceivedCarriesNonDataType(received, new Set(["symbol"]))).toBe(
				false,
			);
		} finally {
			sb.dispose();
		}
	});
});

describe("__hostCallAction: security boundary", () => {
	it("action not declared in the manifest is rejected; no bypass", async () => {
		// Simulates a malicious guest attempting to call an action that
		// does not exist in the host's manifest (sandbox escape attempt).
		const invokedActions: string[] = [];
		const dispatcher = buildDispatcher({
			declared: {
				input: (v) => v,
				output: (v) => v,
				handler: async (v) => {
					invokedActions.push("declared");
					return v;
				},
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				const errors = [];
				for (const name of ["escape", "__proto__", "constructor", ""]) {
					try {
						await __hostCallAction(name, {});
						errors.push({ name, ok: true });
					} catch (err) {
						errors.push({ name, ok: false, message: err.message });
					}
				}
				return errors;
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const attempts = result.result as Array<{
					name: string;
					ok: boolean;
				}>;
				for (const a of attempts) {
					expect(a.ok).toBe(false);
				}
			}
			// And no declared actions should have been invoked.
			expect(invokedActions).toEqual([]);
		} finally {
			sb.dispose();
		}
	});

	it("__proto__ and constructor.prototype keys in payloads do not pollute host prototypes", async () => {
		const protoBefore = { ...Object.prototype };
		const receivedInputs: unknown[] = [];

		const dispatcher = async (...args: unknown[]): Promise<unknown> => {
			const [, input] = args;
			receivedInputs.push(input);
			return null;
		};

		const sb = await sandbox(
			`export default async (ctx) => {
				// Ship a payload with prototype-pollution shapes. The host
				// must treat them as data, not as prototype mutations.
				const payload = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');
				await __hostCallAction("any", payload);
				return true;
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			// Host Object.prototype must not have a "polluted" key.
			expect(
				(Object.prototype as unknown as Record<string, unknown>).polluted,
			).toBeUndefined();
			// Ensure the global object prototype is unchanged.
			expect(Object.keys(Object.prototype).sort()).toEqual(
				Object.keys(protoBefore).sort(),
			);
			// The dispatcher should have received SOMETHING — what matters is
			// that nothing above mutated Object.prototype.
			expect(receivedInputs.length).toBe(1);
		} finally {
			sb.dispose();
		}
	});

	it("guest cannot redefine the installed __hostCallAction to bypass the bridge", async () => {
		// Once installed, the global is a QuickJS function backed by the
		// RPC. Reassigning the global from guest code just replaces the
		// reference in the guest — it cannot cause the host to route calls
		// anywhere else. We verify the guest can still call the original
		// through the bridge even after attempting to shadow it.
		const dispatcher = buildDispatcher({
			ping: {
				input: (v) => v,
				output: (v) => v,
				handler: async () => "pong-from-host",
			},
		});

		const sb = await sandbox(
			`export default async (ctx) => {
				// Attempt 1: overwrite on globalThis.
				let overwriteThrew = false;
				try {
					globalThis.__hostCallAction = async () => "HIJACKED";
				} catch (err) {
					overwriteThrew = true;
				}
				// After reassignment, the global in this guest scope now
				// points at the attacker function. The bridge itself is
				// unaffected, and the original RPC routing lives in the
				// host (worker). The attacker can only redirect their OWN
				// calls — the sandbox package guarantees no *other* caller
				// is affected, because there is no shared mutable state
				// between sandboxes.
				// But the critical security property is: the attacker
				// cannot make the host call a handler not in the manifest.
				// Reset and confirm real dispatch still works.
				delete globalThis.__hostCallAction;
				// After delete, globalThis has no __hostCallAction. But the
				// host-side function cannot be re-bound by the guest; the
				// sandbox does NOT re-install it. Expect a ReferenceError.
				let callAfterDelete;
				try {
					callAfterDelete = await __hostCallAction("ping", {});
				} catch (err) {
					callAfterDelete = { threw: err.message };
				}
				return { overwriteThrew, callAfterDelete };
			}`,
			{ __hostCallAction: dispatcher },
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const { callAfterDelete } = result.result as {
					callAfterDelete: unknown;
				};
				// After delete, the guest has no reference to the host
				// bridge — the call must fail with something like
				// "is not a function" / reference error. The attacker
				// cannot bypass the bridge to reach the host.
				expect(callAfterDelete).toMatchObject({ threw: expect.any(String) });
			}
		} finally {
			sb.dispose();
		}
	});

	it("__hostCallAction is NOT present when not passed in methods (no silent fallback)", async () => {
		// Construct a sandbox WITHOUT passing __hostCallAction. The
		// sandbox package does not hardcode it as a built-in, so the
		// global is absent. Guest code that attempts to call it must
		// observe a ReferenceError / TypeError rather than any silent
		// fallback behaviour.
		const sb = await sandbox(
			`export default async (ctx) => {
				const typeofBefore = typeof __hostCallAction;
				let threwMessage = null;
				let threwName = null;
				try {
					await __hostCallAction("x", {});
				} catch (err) {
					threwMessage = err.message;
					threwName = err.name;
				}
				return { typeofBefore, threwMessage, threwName };
			}`,
			{},
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const { typeofBefore, threwMessage, threwName } = result.result as {
					typeofBefore: string;
					threwMessage: string | null;
					threwName: string | null;
				};
				// `typeof` on an undeclared identifier returns "undefined"
				// without throwing — so this confirms the identifier is not
				// present in the guest global scope.
				expect(typeofBefore).toBe("undefined");
				// And when called, guest receives a throw (ReferenceError
				// or TypeError) — the bridge is not silently consulted.
				expect(threwMessage).toEqual(expect.any(String));
				expect(threwMessage).toMatch(MISSING_GLOBAL_MESSAGE_RE);
				expect(threwName).toMatch(MISSING_GLOBAL_NAME_RE);
			}
		} finally {
			sb.dispose();
		}
	});
});

describe("host-bridge surface inventory", () => {
	it("built-in globals match the documented list exactly (SECURITY.md §2)", async () => {
		// Regression test for SECURITY.md §2. When the sandbox is
		// constructed with no extra methods, the ONLY host-bridged
		// globals installed must be: console.*, performance.now,
		// crypto.*, setTimeout, setInterval, clearTimeout, clearInterval,
		// __hostFetch. The addition of __hostCallAction is a CONVENTION
		// the runtime follows by passing it in `methods` — it is NOT a
		// hardcoded built-in. Adding or removing a global without
		// updating SECURITY.md fails this test.
		//
		// Standard JS globals (Math, Date, JSON, Promise, …) MUST remain
		// present — they are part of QuickJS's ECMAScript implementation,
		// not a host bridge, but workflow authors rely on them so their
		// absence would be a regression.
		const sb = await sandbox(
			`export default async (ctx) => {
				const bridged = [
					"console", "performance", "crypto",
					"setTimeout", "setInterval", "clearTimeout", "clearInterval",
					"__hostFetch",
					// Should NOT be installed as a built-in:
					"__hostCallAction",
					"emit",
					"process", "require", "fetch", "global", "window",
					"Buffer", "fs", "net",
				];
				const jsStandard = [
					"Math", "Date", "JSON", "Promise", "Object", "Array",
					"String", "Number", "Boolean", "Error", "RegExp", "Map",
					"Set", "Symbol",
				];
				const present = {};
				for (const n of [...bridged, ...jsStandard]) {
					present[n] = typeof globalThis[n];
				}
				return present;
			}`,
			{},
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const types = result.result as Record<string, string>;
				// Built-in host-bridge surface (must be present).
				expect(types.console).toBe("object");
				expect(types.performance).toBe("object");
				expect(types.crypto).toBe("object");
				expect(types.setTimeout).toBe("function");
				expect(types.setInterval).toBe("function");
				expect(types.clearTimeout).toBe("function");
				expect(types.clearInterval).toBe("function");
				expect(types.__hostFetch).toBe("function");
				// Runtime-passed conventions (must NOT be present unless passed).
				expect(types.__hostCallAction).toBe("undefined");
				expect(types.emit).toBe("undefined");
				// Node APIs must not be present.
				expect(types.process).toBe("undefined");
				expect(types.require).toBe("undefined");
				expect(types.fetch).toBe("undefined");
				expect(types.global).toBe("undefined");
				expect(types.window).toBe("undefined");
				expect(types.Buffer).toBe("undefined");
				expect(types.fs).toBe("undefined");
				expect(types.net).toBe("undefined");
				// Standard JS globals (QuickJS-provided) — must be present.
				expect(types.Math).toBe("object");
				expect(types.JSON).toBe("object");
				expect(types.Date).toBe("function");
				expect(types.Promise).toBe("function");
				expect(types.Object).toBe("function");
				expect(types.Array).toBe("function");
				expect(types.String).toBe("function");
				expect(types.Number).toBe("function");
				expect(types.Boolean).toBe("function");
				expect(types.Error).toBe("function");
				expect(types.RegExp).toBe("function");
				expect(types.Map).toBe("function");
				expect(types.Set).toBe("function");
				expect(types.Symbol).toBe("function");
			}
		} finally {
			sb.dispose();
		}
	});

	it("__hostCallAction becomes a global only when passed via methods", async () => {
		const methods: MethodMap = {
			__hostCallAction: async () => "stubbed",
		};
		const sb = await sandbox(
			`export default async (ctx) => {
				return {
					present: typeof __hostCallAction,
					result: await __hostCallAction("x", {}),
				};
			}`,
			methods,
		);
		try {
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toEqual({
					present: "function",
					result: "stubbed",
				});
			}
		} finally {
			sb.dispose();
		}
	});
});
