import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { limitedAll } from "./harness/limited-all.js";
import {
	declaredSubtestSkips,
	findMissingSubtestSkips,
	findReason,
} from "./harness/match.js";
import { runWpt, type SubtestResult } from "./harness/runner.js";
import skipJson from "./skip.json" with { type: "json" };

// Skip map for the WPT runner. Pass is implicit: any applicable test
// (worker-globals-applicable per WPT META; see wpt-refresh.ts) that is NOT
// matched by an entry here is expected to pass.
//
// Keys are glob patterns or file:subtest strings. Values are the human
// reason. Most-specific match wins. There is no override mechanism — a
// glob skip swallows every file underneath, so if you ever need a narrower
// pass you must expand the glob into per-file entries first.
//
// Polyfill backlog: every reason that names a polyfill follows the
// convention `"needs <X> polyfill"`. Reconstruct the queue with:
//   grep '"needs .* polyfill"' skip.json
const skip = skipJson as Record<string, string>;

interface RunnableEntry {
	scripts: string[];
	timeout?: "long";
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
		process.env.WPT_CONCURRENCY ??
			Math.max(1, Math.floor(availableParallelism() / 2)),
	);

	const runnable: Array<{ path: string; entry: RunnableEntry }> = [];
	const skipped: Array<{ path: string; reason: string }> = [];
	for (const [path, entry] of Object.entries(manifest.tests)) {
		if ("skip" in entry) {
			skipped.push({ path, reason: entry.skip.reason });
			continue;
		}
		const reason = findReason(skip, path);
		if (reason !== null) {
			skipped.push({ path, reason });
			continue;
		}
		runnable.push({ path, entry });
	}

	const results = await limitedAll(
		runnable.map(
			({ path, entry }) =>
				() =>
					runWpt(path, entry).then((subtests) => [path, subtests] as const),
		),
		concurrency,
	);

	for (const { path, reason } of skipped) {
		describe(path, () => {
			it.skip(`(skipped: ${reason})`, () => {});
		});
	}
	for (const [path, subtestResults] of results) {
		registerFileTests(path, subtestResults);
	}
}

function registerFileTests(
	path: string,
	subtestResults: SubtestResult[],
): void {
	describe(path, () => {
		if (subtestResults.length === 0) {
			it("<no subtests reported>", () => {
				throw new Error(
					"file produced zero subtest reports (likely broken setup)",
				);
			});
			return;
		}
		for (const { name, status, message } of subtestResults) {
			const subReason = findReason(skip, `${path}:${name}`);
			if (subReason !== null) {
				it.skip(`${name} — ${subReason}`, () => {});
				continue;
			}
			it(name, () => {
				if (status !== "PASS") {
					throw new Error(`${status}${message ? `: ${message}` : ""}`);
				}
				expect(status).toBe("PASS");
			});
		}

		// Drift: a subtest skip whose name never appears means the upstream
		// subtest was likely renamed; refresh-time validation only catches
		// file-level renames.
		const declared = declaredSubtestSkips(skip, path);
		for (const name of findMissingSubtestSkips(declared, subtestResults)) {
			it(`<missing declared subtest '${name}'>`, () => {
				throw new Error(
					`skip.ts declares skip for '${name}', but subtest never ran (renamed upstream?)`,
				);
			});
		}
	});
}
