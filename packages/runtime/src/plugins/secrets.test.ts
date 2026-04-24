import type { PluginSetup, WorkerToMain } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import { worker } from "./secrets.js";

// The secrets plugin's `worker()` takes a SandboxContext it never uses, so
// we pass null through an unknown cast. Each test calls `worker()` fresh to
// reseed the module-scoped `activePlaintexts` list from the config.
function bootstrap(
	plaintextStore: Record<string, string> = {},
	env: Record<string, string> = {},
): PluginSetup {
	const setup = worker(
		null as unknown as never,
		{},
		{
			name: "wf",
			env,
			plaintextStore,
		},
	);
	if (!setup) {
		throw new Error("secrets.worker() returned undefined");
	}
	return setup;
}

interface LogMsg {
	readonly type: "log";
	readonly level: "debug" | "info" | "warn" | "error";
	readonly message: string;
	readonly meta: Record<string, unknown>;
}

function logMsg(message: string, meta: Record<string, unknown> = {}): LogMsg {
	return { type: "log", level: "info", message, meta };
}

function asLogMsg(result: WorkerToMain | undefined): LogMsg {
	if (!result || result.type !== "log") {
		throw new Error(`expected log msg, got ${JSON.stringify(result)}`);
	}
	return {
		type: result.type,
		level: result.level,
		message: result.message,
		meta: result.meta ?? {},
	};
}

describe("secrets plugin onPost scrubber", () => {
	it("returns msg unchanged when no plaintexts are active", () => {
		const setup = bootstrap({});
		const msg = logMsg("hello world");
		expect(setup.onPost?.(msg)).toEqual(msg);
	});

	it("replaces literal plaintext in a top-level string field", () => {
		const setup = bootstrap({ TOKEN: "abc123" });
		const result = setup.onPost?.(logMsg("token=abc123"));
		expect(result).toEqual(logMsg("token=[secret]"));
	});

	it("replaces every occurrence of a plaintext in the same string", () => {
		const setup = bootstrap({ X: "abc" });
		const result = asLogMsg(setup.onPost?.(logMsg("abc abc abc")));
		expect(result.message).toBe("[secret] [secret] [secret]");
	});

	it("recurses into nested objects and arrays and preserves non-string leaves", () => {
		const setup = bootstrap({ X: "abc" });
		const result = asLogMsg(
			setup.onPost?.(
				logMsg("x", {
					nested: {
						arr: ["abc", { field: "abc" }, 42, true, null],
						n: 42,
						b: true,
						s: "abc",
					},
				}),
			),
		);
		const nested = result.meta.nested as Record<string, unknown>;
		expect(nested.arr).toEqual([
			"[secret]",
			{ field: "[secret]" },
			42,
			true,
			null,
		]);
		expect(nested.n).toBe(42);
		expect(nested.b).toBe(true);
		expect(nested.s).toBe("[secret]");
	});

	it("applies longest-first ordering for overlapping plaintexts", () => {
		const setup = bootstrap({ LONG: "password", SHORT: "pass" });
		const result = asLogMsg(setup.onPost?.(logMsg("mypassword passcode")));
		// Longest-first: "password" → "my[secret] passcode", then "pass" →
		// "my[secret] [secret]code". If ordering regressed to shortest-first,
		// "pass" would replace inside "password" and the long value would
		// never match, leaving the plaintext "word" dangling.
		expect(result.message).toBe("my[secret] [secret]code");
	});

	it("is case-sensitive (literal match only)", () => {
		const setup = bootstrap({ X: "abc" });
		const result = asLogMsg(setup.onPost?.(logMsg("ABC abc AbC")));
		expect(result.message).toBe("ABC [secret] AbC");
	});

	it("filters empty-string plaintexts at seed time", () => {
		const setup = bootstrap({ EMPTY: "", REAL: "abc" });
		const result = asLogMsg(setup.onPost?.(logMsg("hello abc")));
		expect(result.message).toBe("hello [secret]");
	});
});

describe("secrets plugin addSecret handler", () => {
	function getAddSecretHandler(setup: PluginSetup): (value: unknown) => void {
		const gf = setup.guestFunctions?.find(
			(d) => d.name === "$secrets/addSecret",
		);
		if (!gf) {
			throw new Error("no $secrets/addSecret guest function on setup");
		}
		return gf.handler as (value: unknown) => void;
	}

	it("grows activePlaintexts so later onPost calls scrub the new value", () => {
		const setup = bootstrap({});
		const addSecret = getAddSecretHandler(setup);
		const before = asLogMsg(setup.onPost?.(logMsg("runtime-secret")));
		expect(before.message).toBe("runtime-secret");
		addSecret("runtime-secret");
		const after = asLogMsg(setup.onPost?.(logMsg("runtime-secret")));
		expect(after.message).toBe("[secret]");
	});

	it("deduplicates added secrets and keeps scrubbing correctly", () => {
		const setup = bootstrap({});
		const addSecret = getAddSecretHandler(setup);
		addSecret("x");
		addSecret("x");
		addSecret("x");
		const result = asLogMsg(setup.onPost?.(logMsg("x x")));
		expect(result.message).toBe("[secret] [secret]");
	});

	it("ignores non-string and empty additions", () => {
		const setup = bootstrap({});
		const addSecret = getAddSecretHandler(setup);
		addSecret("");
		addSecret(42);
		addSecret(null);
		addSecret(undefined);
		addSecret({ token: "x" });
		const result = asLogMsg(setup.onPost?.(logMsg("hello 42")));
		expect(result.message).toBe("hello 42");
	});
});

describe("secrets plugin onPost hardening", () => {
	it("returns a safe placeholder when walkStrings throws", () => {
		const setup = bootstrap({ X: "plaintext-abc" });
		const evil = {} as WorkerToMain;
		// A throwing getter forces walkStrings into the catch branch. The
		// error message deliberately contains plaintext-shaped content to
		// prove the caught error is NOT included in the returned msg.
		// `enumerable: true` is load-bearing — walkStrings iterates
		// `Object.entries`, which skips non-enumerable properties.
		Object.defineProperty(evil, "type", {
			enumerable: true,
			get() {
				throw new Error("payload referencing plaintext-abc");
			},
		});
		const result = setup.onPost?.(evil);
		expect(result).toEqual({
			type: "log",
			level: "error",
			message: "sandbox.plugin.secrets_scrub_failed",
			meta: {},
		});
		// Containment: neither the caught error's message nor the plaintext
		// appears anywhere in the returned msg.
		expect(JSON.stringify(result)).not.toContain("plaintext-abc");
		expect(JSON.stringify(result)).not.toContain("payload referencing");
	});
});
