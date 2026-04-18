import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Sandbox, sandbox } from "../../../src/index.js";
import { compose } from "./composer.js";

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
		sb = await sandbox(
			source,
			{
				__wptReport: async (...args: unknown[]): Promise<unknown> => {
					const [name, status, message] = args as [
						string,
						SubtestStatus,
						string,
					];
					captured.push({ name, status, message });
					return;
				},
			},
			{ memoryLimit: MEMORY_LIMIT },
		);
		await sb.run(
			"__wptEntry",
			{},
			{
				invocationId: `wpt_${path}`,
				tenant: "wpt",
				workflow: "wpt",
				workflowSha: "",
			},
		);
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
