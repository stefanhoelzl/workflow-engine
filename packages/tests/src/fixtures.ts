import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { build } from "@workflow-engine/sdk/cli";
import {
	CACHE_DIR,
	fixtureCacheHit,
	fixtureCachePath,
	fixtureKey,
} from "./fixtures/cache.js";

interface FixtureWorkflow {
	name: string;
	source: string;
}

interface BuildFixtureOptions {
	workflows: readonly FixtureWorkflow[];
	// Hermetic env passed to the SDK build's IIFE-eval VM. Empty by default
	// so a fixture only sees what the describe explicitly declared via
	// `buildEnv`. Included in the cache key so identical sources with
	// different envs do not collide.
	buildEnv?: Record<string, string>;
}

interface BuildFixtureResult {
	cwd: string;
	names: readonly string[];
	workflows: ReadonlyArray<{ name: string; sha: string }>;
}

const SHAS_FILE = ".shas.json";
const SHAS_WAIT_HARDCAP_MS = 60_000;
const SHAS_WAIT_INTERVAL_MS = 25;

async function waitForShasFile(
	path: string,
): Promise<ReadonlyArray<{ name: string; sha: string }>> {
	const deadline = Date.now() + SHAS_WAIT_HARDCAP_MS;
	while (true) {
		try {
			return JSON.parse(await readFile(path, "utf8")) as {
				name: string;
				sha: string;
			}[];
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				throw err;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`buildFixture: race-lost worker timed out waiting for ${path} (${String(SHAS_WAIT_HARDCAP_MS)}ms); the winning worker likely crashed mid-build`,
				);
			}
			await new Promise((res) => setTimeout(res, SHAS_WAIT_INTERVAL_MS));
		}
	}
}

async function writeFixtureProject(
	cwd: string,
	id: string,
	workflows: readonly FixtureWorkflow[],
): Promise<void> {
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(
		join(cwd, "package.json"),
		`${JSON.stringify(
			{
				name: `wfe-tests-fixture-${id}`,
				version: "0.0.0",
				type: "module",
				private: true,
				dependencies: { "@workflow-engine/sdk": "workspace:*" },
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	for (const wf of workflows) {
		await writeFile(join(cwd, "src", `${wf.name}.ts`), wf.source, "utf8");
	}
}

// Writes the inline workflow source to a fixture project, runs the SDK's
// `build()` against the given hermetic env, and caches the resulting project
// under `node_modules/.cache/wfe-tests/<key>/`. Cache key:
//   sha256(workflows[name+source] + sorted buildEnv)
// owner/repo are upload-time only and excluded from the key. The cache is
// wiped en-masse by `globalSetup` (cache.ts:syncSentinel) when the SDK or
// core dist changes; per-entry invalidation is unnecessary.
async function buildFixture(
	opts: BuildFixtureOptions,
): Promise<BuildFixtureResult> {
	const buildEnv = opts.buildEnv ?? {};
	const key = fixtureKey({ workflows: opts.workflows, buildEnv });
	const cwd = fixtureCachePath(key);
	const names = opts.workflows.map((w) => w.name);

	if (await fixtureCacheHit(key)) {
		const cachedShas = JSON.parse(
			await readFile(join(cwd, SHAS_FILE), "utf8"),
		) as { name: string; sha: string }[];
		return { cwd, names, workflows: cachedShas };
	}

	// Cache miss — stage src + package.json inside the cache directory (so
	// NodeNext resolution from `src/*.ts` walks up into
	// `packages/tests/node_modules/@workflow-engine/sdk`), atomically rename
	// staging → final cwd, then run `build()` AT the final cwd.
	//
	// Why build at final cwd rather than staging: Vite/Rolldown emit
	// path-bearing region comments (`//#region <relpath>/zod...js`) in the
	// IIFE bundle. The bundle bytes — and therefore the workflow sha
	// (`createHash("sha256").update(bundleSource)`) — depend on cwd.
	// `bundle()` at upload time runs `buildWorkflows({cwd: <final>})`, so
	// the canonical sha is the one produced at the final cwd. If we built
	// in staging and renamed, the cached `.shas.json` would carry a
	// staging-cwd sha that disagrees with the upload-time runtime view —
	// breaking any test that asserts on `state.uploads.byLabel(...).workflows[0].sha`
	// (e.g. test #5's eviction-line sha match).
	await mkdir(CACHE_DIR, { recursive: true });
	const staging = await mkdtemp(join(CACHE_DIR, `${key}.staging-`));
	let workflows: ReadonlyArray<{ name: string; sha: string }>;
	try {
		await writeFixtureProject(staging, key, opts.workflows);
		try {
			await rename(staging, cwd);
		} catch (err) {
			// Race lost: another worker landed the same key first. Their
			// entry is by-construction equivalent (same key = same inputs +
			// same final-cwd build). Drop staging and wait for the winner to
			// finish writing `.shas.json` (the build runs after the rename,
			// so the file briefly does not exist).
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") {
				throw err;
			}
			await rm(staging, { recursive: true, force: true });
			workflows = await waitForShasFile(join(cwd, SHAS_FILE));
			return { cwd, names, workflows };
		}
		const result = await build({ cwd, env: buildEnv });
		workflows = result.workflows.map((w) => ({ name: w.name, sha: w.sha }));
		await writeFile(join(cwd, SHAS_FILE), JSON.stringify(workflows), "utf8");
	} catch (err) {
		// Best-effort cleanup of either staging (if rename hadn't happened)
		// or the partially-built final cwd (if the post-rename build failed).
		await rm(staging, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
		throw err;
	}

	return { cwd, names, workflows };
}

export type { BuildFixtureOptions, BuildFixtureResult, FixtureWorkflow };
export { buildFixture };
