import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Sandbox, sandbox } from "../../../src/index.js";
import { compose } from "./composer.js";

interface RunnableEntry {
	scripts: readonly string[];
	timeout?: "long";
	skippedSubtests?: Record<string, string>;
}

interface SubtestResult {
	name: string;
	status: "PASS" | "FAIL" | "TIMEOUT" | "NOTRUN" | "PRECONDITION_FAILED";
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

interface RunOptions {
	defaultDeadlineMs?: number;
	longDeadlineMs?: number;
}

function findMissingSkips(
	declared: Record<string, string> | undefined,
	observed: readonly { name: string }[],
): string[] {
	if (!declared) {
		return [];
	}
	const observedNames = new Set(observed.map((r) => r.name));
	return Object.keys(declared).filter((n) => !observedNames.has(n));
}

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

async function runWpt(
	path: string,
	entry: RunnableEntry,
	options: RunOptions = {},
): Promise<SubtestResult[]> {
	const source = compose({
		testharness: readVendor(TESTHARNESS_REL),
		deps: entry.scripts.filter((s) => s !== TESTHARNESS_REL).map(readVendor),
		file: readVendor(path),
	});

	const captured: SubtestResult[] = [];
	const defaultDeadline = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
	const longDeadline = options.longDeadlineMs ?? LONG_DEADLINE_MS;
	const deadlineMs = entry.timeout === "long" ? longDeadline : defaultDeadline;
	let sb: Sandbox | null = null;
	let watchdogFired = false;
	const watchdog = setTimeout(() => {
		watchdogFired = true;
		sb?.dispose();
	}, deadlineMs);

	try {
		sb = await sandbox(source, {}, { memoryLimit: MEMORY_LIMIT });
		await sb.run(
			"__wptEntry",
			{},
			{
				invocationId: `wpt_${path}`,
				workflow: "wpt",
				workflowSha: "",
				extraMethods: {
					__wptReport: async (...args: unknown[]): Promise<unknown> => {
						const [name, status, message] = args as [
							string,
							SubtestResult["status"],
							string,
						];
						captured.push({ name, status, message });
						return;
					},
				},
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

export type { RunnableEntry, RunOptions, SubtestResult };
export { findMissingSkips, runWpt };
