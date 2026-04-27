import { sandbox } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import wasiPlugin from "../../../sandbox/src/plugins/wasi-plugin.ts?sandbox-plugin";
import webPlatformPlugin from "./index.ts?sandbox-plugin";

// Presence guards for the targeted core-js modules imported by
// `web-platform/guest/entry.ts`. WPT does NOT exercise these ES features
// in our applicable suite (Iterator helpers, new Set methods, Object/Map
// .groupBy, Array.fromAsync are ECMAScript proposals — not web-platform).
// Without these assertions, dropping a `core-js/stable/<feature>` import
// would land silently and break workflow-author code at runtime with no
// CI signal.
//
// URL.prototype.searchParams live two-way binding is intentionally NOT
// tested here — `url/urlsearchparams-foreach.any.js` and
// `url/url-searchparams.any.js` in WPT cover the surface more thoroughly.

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

const PLUGINS = [{ ...wasiPlugin }, { ...webPlatformPlugin }];

const PROBE_LIMITS = {
	memoryBytes: 67_108_864,
	stackBytes: 524_288,
	cpuMs: 30_000,
	outputBytes: 33_554_432,
	pendingCallables: 256,
} as const;

async function runProbe(body: string): Promise<unknown> {
	const sb = await sandbox({
		...PROBE_LIMITS,
		source: iife(`exports.probe = async function() { ${body} };`),
		plugins: PLUGINS,
	});
	try {
		const r = await sb.run("probe", {});
		if (!r.ok) {
			throw new Error(`probe failed: ${r.error.message}`);
		}
		return r.result;
	} finally {
		sb.dispose();
	}
}

describe("core-js targeted polyfills (feature presence)", () => {
	it("Iterator helpers are installed", async () => {
		const result = await runProbe(`
			return {
				iteratorFrom: typeof Iterator !== "undefined" && typeof Iterator.from === "function",
				arrayIterMap: typeof [].values().map === "function",
			};
		`);
		expect(result).toEqual({ iteratorFrom: true, arrayIterMap: true });
	});

	it("new Set methods are installed", async () => {
		const result = await runProbe(`
			return typeof new Set().intersection === "function";
		`);
		expect(result).toBe(true);
	});

	it("Object.groupBy / Map.groupBy / Array.fromAsync are installed", async () => {
		const result = await runProbe(`
			return {
				objectGroupBy: typeof Object.groupBy === "function",
				mapGroupBy: typeof Map.groupBy === "function",
				arrayFromAsync: typeof Array.fromAsync === "function",
			};
		`);
		expect(result).toEqual({
			objectGroupBy: true,
			mapGroupBy: true,
			arrayFromAsync: true,
		});
	});
});
