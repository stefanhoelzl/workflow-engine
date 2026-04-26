import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
		return { cwd, names };
	}

	// Cache miss — stage inside the cache directory itself so that NodeNext
	// module resolution from the fixture's src/*.ts walks up into
	// `packages/tests/node_modules/@workflow-engine/sdk`. A `/tmp` staging
	// would break that walk and fail typecheck. Atomic rename within the same
	// directory is also fast and avoids EXDEV across filesystems.
	await mkdir(CACHE_DIR, { recursive: true });
	const staging = await mkdtemp(join(CACHE_DIR, `${key}.staging-`));
	try {
		await writeFixtureProject(staging, key, opts.workflows);
		await build({ cwd: staging, env: buildEnv });
		try {
			await rename(staging, cwd);
		} catch (err) {
			// Race lost: another worker landed the same key first. Their
			// entry is by-construction equivalent (same key = same inputs).
			// Drop our staging.
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") {
				throw err;
			}
			await rm(staging, { recursive: true, force: true });
		}
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		throw err;
	}

	return { cwd, names };
}

export type { BuildFixtureOptions, BuildFixtureResult, FixtureWorkflow };
export { buildFixture };
