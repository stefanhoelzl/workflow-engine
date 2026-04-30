// Globals-surface enforcement test (R-14, see SECURITY.md §2).
//
// Boots two sandboxes — one with NOOP_PLUGINS (baseline = ES + quickjs-wasi
// engine surface + the workflow IIFE's own `__wfe_exports__`) and one with
// the production plugin set returned by `buildPluginDescriptors` — and
// asserts that the *delta* between them is exactly the documented set of
// plugin-induced globals.
//
// Adding, renaming, or removing a guest-visible global on `globalThis`
// MUST update both this file's inline const arrays AND `SECURITY.md` §2
// "Globals surface (post-init guest-visible)" in the same change.

import type { WorkflowManifest } from "@workflow-engine/core";
import { type PluginDescriptor, sandbox } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import { buildPluginDescriptors } from "./sandbox-store.js";
import type { SecretsKeyStore } from "./secrets/index.js";

// --- Inline test fixtures -------------------------------------------------

const NOOP_PLUGINS: readonly PluginDescriptor[] = [
	{ name: "noop", workerSource: "export default () => ({});" },
];

const TEST_LIMITS = {
	memoryBytes: 67_108_864,
	stackBytes: 524_288,
	cpuMs: 30_000,
	outputBytes: 33_554_432,
	pendingCallables: 256,
} as const;

const STUB_KEY_STORE: SecretsKeyStore = {
	getPrimary: () => ({
		keyId: "0000000000000000",
		pk: new Uint8Array(32),
		sk: new Uint8Array(32),
	}),
	lookup: () => undefined,
	allKeyIds: () => ["0000000000000000"],
};

const WORKFLOW: WorkflowManifest = {
	name: "globals-surface-fixture",
	module: "globals-surface-fixture.js",
	sha: "a".repeat(64),
	env: {},
	actions: [
		{
			name: "listGlobals",
			input: { type: "object" },
			output: { type: "array", items: { type: "string" } },
		},
		{
			name: "tryLock",
			input: { type: "object" },
			output: { type: "string" },
		},
	],
	triggers: [],
};

// IIFE bundle: assigns exports onto `globalThis.__wfe_exports__` (the fixed
// namespace the sandbox reads exports from — see IIFE_NAMESPACE in
// @workflow-engine/core). Mirrors the hand-authored bundle pattern in
// `packages/runtime/src/sandbox-store.test.ts`.
//
// Handlers do not route through `__sdk.dispatchAction` because the baseline
// (NOOP_PLUGINS) sandbox has no `__sdk` global. The handlers exercise only
// the surfaces under test (`Object.getOwnPropertyNames`, `defineProperty`).
const BUNDLE_SOURCE = `
var __wfe_exports__ = (function(exports) {
  exports.listGlobals = async () => Object.getOwnPropertyNames(globalThis).sort();
  exports.tryLock = async (input) => {
    try {
      Object.defineProperty(globalThis, input.name, {
        value: 1,
        writable: true,
        configurable: true,
      });
      return "no-throw";
    } catch (e) {
      return (e && e.name) || "unknown";
    }
  };
  return exports;
})({});
`;

// --- Expected plugin-induced delta ---------------------------------------
//
// Grouped by source plugin so a contributor adding a global knows exactly
// which array to extend. The union of these arrays MUST equal
// (production globals) − (baseline globals) at the post-init snapshot.

// `secrets` plugin (packages/runtime/src/plugins/secrets.ts):
const SECRETS_GLOBALS = ["$secrets", "workflow"] as const;

// `sdk-support` plugin (packages/sdk/src/sdk-support/index.ts):
const SDK_SUPPORT_GLOBALS = ["__sdk"] as const;

// `sql` plugin (packages/sandbox-stdlib/src/sql/index.ts):
const SQL_GLOBALS = ["__sql"] as const;

// `mail` plugin (packages/sandbox-stdlib/src/mail/index.ts):
const MAIL_GLOBALS = ["__mail"] as const;

// `timers` plugin (packages/sandbox-stdlib/src/timers/index.ts):
const TIMERS_GLOBALS = [
	"clearInterval",
	"clearTimeout",
	"setInterval",
	"setTimeout",
] as const;

// `console` plugin (packages/sandbox-stdlib/src/console/index.ts):
const CONSOLE_GLOBALS = ["console"] as const;

// `fetch` plugin (packages/sandbox-stdlib/src/fetch/index.ts):
const FETCH_GLOBALS = ["fetch"] as const;

// `web-platform` plugin (packages/sandbox-stdlib/src/web-platform/...):
//   • EventTarget family + identity shims (self, navigator, reportError)
//   • EventTarget proxy methods (addEventListener / removeEventListener /
//     dispatchEvent — mirrored from `self`)
//   • AbortController / AbortSignal
//   • URLPattern, CompressionStream / DecompressionStream
//   • Streams family
//   • Blob, File, FormData, Request, Response
//   • IndexedDB family
//   • User Timing (PerformanceMark, PerformanceMeasure, PerformanceEntry)
//   • scheduler (TaskController, TaskPriorityChangeEvent)
//   • Observable, Subscriber
//   • core-js conformance shim ('__core-js_shared__' — see §2)
const WEB_PLATFORM_GLOBALS = [
	"AbortController",
	"AbortSignal",
	"Blob",
	"ByteLengthQueuingStrategy",
	"CompressionStream",
	"CountQueuingStrategy",
	"CustomEvent",
	"DecompressionStream",
	"ErrorEvent",
	"Event",
	"EventTarget",
	"File",
	"FormData",
	"IDBCursor",
	"IDBCursorWithValue",
	"IDBDatabase",
	"IDBFactory",
	"IDBIndex",
	"IDBKeyRange",
	"IDBObjectStore",
	"IDBOpenDBRequest",
	"IDBRequest",
	"IDBTransaction",
	"IDBVersionChangeEvent",
	"Observable",
	"PerformanceEntry",
	"PerformanceMark",
	"PerformanceMeasure",
	"ReadableByteStreamController",
	"ReadableStream",
	"ReadableStreamBYOBReader",
	"ReadableStreamBYOBRequest",
	"ReadableStreamDefaultController",
	"ReadableStreamDefaultReader",
	"Request",
	"Response",
	"Subscriber",
	"TaskController",
	"TaskPriorityChangeEvent",
	"TextDecoderStream",
	"TextEncoderStream",
	"TransformStream",
	"TransformStreamDefaultController",
	"URLPattern",
	"WritableStream",
	"WritableStreamDefaultController",
	"WritableStreamDefaultWriter",
	"__core-js_shared__",
	"addEventListener",
	"dispatchEvent",
	"indexedDB",
	"navigator",
	"removeEventListener",
	"reportError",
	"scheduler",
	"self",
] as const;

const EXPECTED_DELTA: readonly string[] = [
	...SECRETS_GLOBALS,
	...SDK_SUPPORT_GLOBALS,
	...SQL_GLOBALS,
	...MAIL_GLOBALS,
	...TIMERS_GLOBALS,
	...CONSOLE_GLOBALS,
	...FETCH_GLOBALS,
	...WEB_PLATFORM_GLOBALS,
];

// --- Test helpers --------------------------------------------------------

async function bootAndListGlobals(
	plugins: readonly PluginDescriptor[],
): Promise<readonly string[]> {
	const sb = await sandbox({
		...TEST_LIMITS,
		source: BUNDLE_SOURCE,
		plugins,
	});
	try {
		const result = await sb.run("listGlobals", {});
		if (!result.ok) {
			throw new Error(`listGlobals failed: ${JSON.stringify(result)}`);
		}
		return result.result as readonly string[];
	} finally {
		await sb.dispose();
	}
}

async function bootAndTryLock(
	plugins: readonly PluginDescriptor[],
	name: string,
): Promise<string> {
	const sb = await sandbox({
		...TEST_LIMITS,
		source: BUNDLE_SOURCE,
		plugins,
	});
	try {
		const result = await sb.run("tryLock", { name });
		if (!result.ok) {
			throw new Error(`tryLock failed: ${JSON.stringify(result)}`);
		}
		return result.result as string;
	} finally {
		await sb.dispose();
	}
}

function diff(a: readonly string[], b: readonly string[]): string[] {
	const bs = new Set(b);
	return a.filter((x) => !bs.has(x)).sort();
}

// --- Tests ---------------------------------------------------------------

describe("globals surface — R-14 enumeration", () => {
	it("production plugin set adds exactly the documented globals over the baseline", async () => {
		const baseline = await bootAndListGlobals(NOOP_PLUGINS);
		const production = await bootAndListGlobals(
			buildPluginDescriptors(WORKFLOW, STUB_KEY_STORE),
		);

		const added = diff(production, baseline);
		const expected = [...EXPECTED_DELTA].sort();

		const unexpectedAdditions = diff(added, expected);
		const missingFromActual = diff(expected, added);

		if (unexpectedAdditions.length > 0 || missingFromActual.length > 0) {
			const guidance = [
				"globals-surface delta does not match expected set.",
				"Update SECURITY.md §2 'Globals surface (post-init",
				"guest-visible)' AND the matching inline const array",
				"in packages/runtime/src/globals-surface.test.ts in the",
				"same change.",
			].join(" ");
			throw new Error(
				`${guidance}\n` +
					`  Unexpected additions (in production, not in expected): ${JSON.stringify(unexpectedAdditions)}\n` +
					`  Missing from actual (in expected, not in production): ${JSON.stringify(missingFromActual)}`,
			);
		}

		expect(added).toEqual(expected);
	}, 60_000);

	it("`__wfe_exports__` is present in both baseline and production (workflow-IIFE-installed)", async () => {
		const baseline = await bootAndListGlobals(NOOP_PLUGINS);
		const production = await bootAndListGlobals(
			buildPluginDescriptors(WORKFLOW, STUB_KEY_STORE),
		);
		expect(baseline).toContain("__wfe_exports__");
		expect(production).toContain("__wfe_exports__");
	}, 60_000);

	// Verifies the locked-outer + frozen-inner installation pattern enforced
	// by §2 R-2: redefining any of these locked globals from the guest must
	// throw TypeError. `__wfe_exports__` is intentionally excluded — it is
	// writable + configurable today; locking it is tracked as sister
	// finding F-4.
	it.each([
		"__sdk",
		"__sql",
		"__mail",
		"$secrets",
		"workflow",
	] as const)("locked global %s rejects guest-side defineProperty redefinition", async (name) => {
		const errorName = await bootAndTryLock(
			buildPluginDescriptors(WORKFLOW, STUB_KEY_STORE),
			name,
		);
		expect(errorName).toBe("TypeError");
	}, 60_000);
});
