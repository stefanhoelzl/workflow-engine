import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type PluginDescriptor,
	type Sandbox,
	sandbox,
} from "@workflow-engine/sandbox";
import wasiPlugin from "../../../../sandbox/src/plugins/wasi-plugin.ts?sandbox-plugin";
import consolePlugin from "../../../src/console/index.ts?sandbox-plugin";
import fetchPlugin from "../../../src/fetch/index.ts?sandbox-plugin";
import timersPlugin from "../../../src/timers/index.ts?sandbox-plugin";
import webPlatformPlugin from "../../../src/web-platform/index.ts?sandbox-plugin";
import SANDBOX_POLYFILLS from "virtual:sandbox-polyfills";
import { compose } from "./composer.js";

// WPT-specific harness plugin: installs a public `__wptReport(name, status,
// message)` guest function that emits a leaf event per subtest. Main
// thread collects via `sb.onEvent` and accumulates the SubtestResult list.
//
// The descriptor is public because guest testharness.js code calls
// `__wptReport` directly; there's no capture-and-delete pattern here.
// Plugin source is loaded via `data:` URI import — bare-specifier imports
// (`import { Guest } from "@workflow-engine/sandbox"`) cannot be resolved
// from a `data:` URL (no base URL context), so we inline the ArgSpec /
// ResultSpec literals that `Guest.string()` / `Guest.void()` would produce.
const WPT_HARNESS_PLUGIN_SOURCE = `
const name = "wpt-harness";
function worker() {
  return {
    guestFunctions: [
      {
        name: "__wptReport",
        args: [
          { kind: "string" },
          { kind: "string" },
          { kind: "string" },
        ],
        result: { kind: "void" },
        handler: () => undefined,
        log: { event: "wpt.report" },
        public: true,
      },
    ],
  };
}
export { name };
export default worker;
`;

const WPT_HARNESS_PLUGIN: PluginDescriptor = {
	name: "wpt-harness",
	source: WPT_HARNESS_PLUGIN_SOURCE,
};

interface RunnableEntry {
	scripts: readonly string[];
	timeout?: "long";
}

type SubtestStatus =
	| "PASS"
	| "FAIL"
	| "TIMEOUT"
	| "NOTRUN"
	| "PRECONDITION_FAILED";

interface SubtestResult {
	name: string;
	status: SubtestStatus;
	message: string;
}

const VENDOR_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"vendor",
);
const TESTHARNESS_REL = "resources/testharness.js";
const MEMORY_LIMIT = 128 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 10_000;
const LONG_DEADLINE_MS = 45_000;

function fileCache(): (relPath: string) => string {
	const cache = new Map<string, string>();
	return (relPath: string) => {
		const cached = cache.get(relPath);
		if (cached !== undefined) {
			return cached;
		}
		const abs = resolve(VENDOR_ROOT, relPath);
		const src = readFileSync(abs, "utf8");
		cache.set(relPath, src);
		return src;
	};
}
const readVendor = fileCache();

// Match `importScripts("x", 'y', ...)`. Captures the comma-separated arg
// list; individual literals are pulled out with ARG_RE. Matches both
// single and double quotes; deliberately ignores template literals and
// dynamic expressions (WPT tests use string literals).
const IMPORT_SCRIPTS_RE =
	/importScripts\s*\(\s*((?:["'][^"']*["']\s*,?\s*)+)\)/g;
const ARG_RE = /["']([^"']+)["']/g;

function resolveImportScriptPath(ref: string, fromFileRel: string): string {
	if (ref.startsWith("/")) {
		return ref.slice(1);
	}
	return join(dirname(fromFileRel), ref);
}

// Normalise resolved vendor-relative path back to the canonical URL key
// the guest code uses (leading "/" for absolute, unchanged for relative).
function urlKey(ref: string, resolved: string): string {
	return ref.startsWith("/") ? `/${resolved}` : ref;
}

function* extractRefs(source: string): Generator<string> {
	for (const match of source.matchAll(IMPORT_SCRIPTS_RE)) {
		const argList = match[1];
		if (!argList) {
			continue;
		}
		for (const arg of argList.matchAll(ARG_RE)) {
			const ref = arg[1];
			if (ref) {
				yield ref;
			}
		}
	}
}

function collectImportScripts(
	rootFileRel: string,
	rootSource: string,
): Record<string, string> {
	const registry: Record<string, string> = {};
	const queue: Array<{ src: string; from: string }> = [
		{ src: rootSource, from: rootFileRel },
	];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}
		for (const ref of extractRefs(item.src)) {
			const resolved = resolveImportScriptPath(ref, item.from);
			const key = urlKey(ref, resolved);
			if (visited.has(key)) {
				continue;
			}
			visited.add(key);
			// Unreadable refs are left out of the registry; the polyfill
			// throws at call time so the failure is visible and
			// attributable to the test.
			let src: string | null = null;
			try {
				src = readVendor(resolved);
			} catch {
				src = null;
			}
			if (src !== null) {
				registry[key] = src;
				queue.push({ src, from: resolved });
			}
		}
	}
	return registry;
}

async function runWpt(
	path: string,
	entry: RunnableEntry,
): Promise<SubtestResult[]> {
	const fileSrc = readVendor(path);
	const depPaths = entry.scripts.filter((s) => s !== TESTHARNESS_REL);
	const source = compose({
		testharness: readVendor(TESTHARNESS_REL),
		deps: depPaths.map(readVendor),
		file: fileSrc,
		scripts: collectImportScripts(path, fileSrc),
		inlinedPaths: [TESTHARNESS_REL, ...depPaths],
	});

	const captured: SubtestResult[] = [];
	const deadlineMs =
		entry.timeout === "long" ? LONG_DEADLINE_MS : DEFAULT_DEADLINE_MS;
	let sb: Sandbox | null = null;
	let watchdogFired = false;
	const watchdog = setTimeout(() => {
		watchdogFired = true;
		sb?.dispose();
	}, deadlineMs);

	try {
		// WPT tests rely on web-platform globals (self, EventTarget, fetch,
		// timers, console, etc.) that live in sandbox-stdlib plugins. Compose
		// the subset of the production plugin list that's relevant to WPT;
		// runtime-only plugins (host-call-action, sdk-support, trigger) are
		// omitted because no action/trigger manifest applies.
		const webPlatformConfig = {
			bundleSource: SANDBOX_POLYFILLS,
		} as unknown as PluginDescriptor["config"];
		sb = await sandbox({
			source,
			plugins: [
				{ ...wasiPlugin },
				{ ...webPlatformPlugin, config: webPlatformConfig },
				{ ...fetchPlugin },
				{ ...timersPlugin },
				{ ...consolePlugin },
				WPT_HARNESS_PLUGIN,
			],
			memoryLimit: MEMORY_LIMIT,
		});
		sb.onEvent((event) => {
			// Plugin-era event kind is open-ended; EventKind's closed union
			// doesn't include `wpt.report`. Compare the string literal.
			if ((event.kind as string) !== "wpt.report") {
				return;
			}
			const input = event.input as
				| readonly [string, SubtestStatus, string]
				| undefined;
			if (!input) {
				return;
			}
			const [name, status, message] = input;
			captured.push({ name, status, message });
		});
		await sb.run("__wptEntry", {});
	} catch (err) {
		if (watchdogFired) {
			captured.push({
				name: "<watchdog>",
				status: "TIMEOUT",
				message: `deadline ${deadlineMs}ms exceeded`,
			});
		} else {
			captured.push({
				name: "<setup>",
				status: "FAIL",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		clearTimeout(watchdog);
		sb?.dispose();
	}
	return captured;
}

export type { RunnableEntry, SubtestResult, SubtestStatus };
export { runWpt };
