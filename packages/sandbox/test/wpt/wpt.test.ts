import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { limitedAll } from "./harness/limited-all.js";
import { findMostSpecific } from "./harness/match.js";
import {
	findMissingSkips,
	runWpt,
	type SubtestResult,
} from "./harness/runner.js";
import { spec } from "./spec.js";

// Runner for the WinterCG MCA-applicable WPT subset. Uses the top-level
// await pattern verified by the spike: pre-run every runnable file via
// limitedAll under an owned concurrency cap, then synchronously register
// one describe per file and one it() per observed subtest.

interface RunnableEntry {
	scripts: string[];
	timeout?: "long";
	skippedSubtests?: Record<string, string>;
}
interface SkipEntry {
	skip: { reason: string };
}
type ManifestTest = RunnableEntry | SkipEntry;

interface Manifest {
	wptSha: string;
	vendoredAt: string;
	tests: Record<string, ManifestTest>;
}

const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "vendor");
const MANIFEST_PATH = resolve(VENDOR_DIR, "manifest.json");

if (existsSync(MANIFEST_PATH)) {
	await runSuite();
} else {
	describe("wpt", () => {
		it("vendor not populated — run `pnpm test:wpt:refresh` first", () => {});
	});
}

async function runSuite(): Promise<void> {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

	const concurrency = Number(
		process.env.WPT_CONCURRENCY ?? Math.max(4, availableParallelism() * 2),
	);

	// Partition.
	const runnable: Array<{ path: string; entry: RunnableEntry }> = [];
	const skipped: Array<{ path: string; reason: string }> = [];
	for (const [path, entry] of Object.entries(manifest.tests)) {
		if ("skip" in entry) {
			skipped.push({ path, reason: entry.skip.reason });
			continue;
		}
		// spec.ts may reclassify a manifest-runnable as skip (dir-level skip
		// over a file that was runnable by the vendor script's view). Runner
		// honors the spec.ts classification.
		const exp = findMostSpecific(spec, path);
		if (!exp) {
			skipped.push({ path, reason: "no spec entry" });
			continue;
		}
		if (exp.expected === "skip") {
			skipped.push({ path, reason: exp.reason });
			continue;
		}
		runnable.push({ path, entry });
	}

	// Run all runnables with owned concurrency cap.
	const results = await limitedAll(
		runnable.map(
			({ path, entry }) =>
				() =>
					runWpt(path, entry).then(
						(subtests) => [path, entry, subtests] as const,
					),
		),
		concurrency,
	);

	// Register.
	for (const { path, reason } of skipped) {
		describe(path, () => {
			it(`(skipped: ${reason})`, () => {});
		});
	}
	for (const [path, entry, subtestResults] of results) {
		registerFileTests(path, entry, subtestResults);
	}
}

function registerFileTests(
	path: string,
	entry: RunnableEntry,
	subtestResults: SubtestResult[],
): void {
	describe(path, () => {
		for (const { name, status, message } of subtestResults) {
			const sub = findMostSpecific(spec, `${path}:${name}`);
			if (sub?.expected === "skip") {
				it(`${name} — ${sub.reason}`, () => {});
				continue;
			}
			const manifestSkip = entry.skippedSubtests?.[name];
			if (manifestSkip !== undefined) {
				it(`${name} — ${manifestSkip}`, () => {});
				continue;
			}
			it(name, () => {
				if (status !== "PASS") {
					throw new Error(`${status}${message ? `: ${message}` : ""}`);
				}
				expect(status).toBe("PASS");
			});
		}

		// Drift: declared skip for a subtest that never ran.
		for (const declaredName of findMissingSkips(
			entry.skippedSubtests,
			subtestResults,
		)) {
			it(`<missing declared subtest '${declaredName}'>`, () => {
				throw new Error(
					`spec declares skip for '${declaredName}', but subtest never ran (renamed upstream?)`,
				);
			});
		}
	});
}
