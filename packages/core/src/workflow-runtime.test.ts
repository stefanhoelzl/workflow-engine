import { describe, expect, it } from "vitest";
import {
	type GuestGlobals,
	installGuestGlobals,
	type RuntimeSecrets,
	type RuntimeWorkflow,
} from "./index.js";

// Each test runs in a fresh sandboxed globalThis so non-configurable installs
// don't leak between tests. We simulate this by running through a proxy object
// that the helper targets via `Object.defineProperty(globalThis, ...)` — since
// the helper uses globalThis directly, we clean up by re-running the helper on
// a fresh describe setup. vitest gives each test file its own module context
// but the same globalThis across tests within a file, so we use distinct keys
// when unavoidable.

type GlobalsWithRuntime = typeof globalThis & Partial<GuestGlobals>;

function clearKey(key: keyof GuestGlobals): void {
	const g = globalThis as GlobalsWithRuntime;
	if (key in g) {
		// Non-configurable properties cannot be deleted; tests that need a fresh
		// slot must avoid the key names we're installing. We only call this
		// defensively — a thrown error here indicates a prior test leaked state.
		try {
			delete (g as unknown as Record<string, unknown>)[key];
		} catch {
			/* non-configurable: ignore */
		}
	}
}

describe("installGuestGlobals", () => {
	it("installs a key with non-configurable, non-writable property descriptor", () => {
		clearKey("workflow");
		const wf: RuntimeWorkflow = { name: "wf1", env: { A: "a" } };
		installGuestGlobals({ workflow: wf });

		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "workflow");
		expect(descriptor).toBeDefined();
		expect(descriptor?.value).toBe(wf);
		expect(descriptor?.writable).toBe(false);
		expect(descriptor?.configurable).toBe(false);
		expect(globalThis.workflow).toBe(wf);
	});

	it("throws when re-installing the same key", () => {
		// Uses the workflow slot from the previous test (already non-configurable).
		const wf2: RuntimeWorkflow = { name: "wf2", env: {} };
		expect(() => installGuestGlobals({ workflow: wf2 })).toThrow(TypeError);
	});

	it("accepts a partial argument (omitting $secrets)", () => {
		// $secrets has not been set yet in this test run. Using a narrow
		// installer-only payload.
		const secrets: RuntimeSecrets = {
			addSecret(_value: string): void {
				/* noop */
			},
		};
		installGuestGlobals({ $secrets: secrets });

		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "$secrets");
		expect(descriptor).toBeDefined();
		expect(descriptor?.value).toBe(secrets);
		expect(descriptor?.writable).toBe(false);
		expect(descriptor?.configurable).toBe(false);
	});
});
