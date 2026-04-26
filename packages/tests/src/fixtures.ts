import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "@workflow-engine/sdk/cli";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "packages", "tests", ".fixtures");

interface FixtureWorkflow {
	name: string;
	source: string;
}

interface BuildFixtureOptions {
	workflows: readonly FixtureWorkflow[];
}

interface BuildFixtureResult {
	cwd: string;
	names: readonly string[];
}

// Writes the inline workflow source to a one-off fixture project under
// `packages/tests/.fixtures/<random>/`, runs the SDK's `build()` to emit
// `dist/<name>.js`, and returns the project root for `upload()` to consume.
// Build-time `env()` resolution reads from `process.env`; the framework
// arranges for the relevant variables to be set in the parent process for
// the duration of the test (via the `describe`-level `buildEnv`).
//
// Cache is intentionally absent in PR 1 — every test rebuilds. The
// `.build-hash`-sentinel cache layer is the optional perf PR.
async function buildFixture(
	opts: BuildFixtureOptions,
): Promise<BuildFixtureResult> {
	const id = randomBytes(8).toString("hex");
	const cwd = join(FIXTURE_ROOT, id);
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
	for (const wf of opts.workflows) {
		await writeFile(join(cwd, "src", `${wf.name}.ts`), wf.source, "utf8");
	}
	await build({ cwd });
	return { cwd, names: opts.workflows.map((w) => w.name) };
}

function sourceHash(source: string): string {
	return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export type { BuildFixtureOptions, BuildFixtureResult };
export { buildFixture, sourceHash };
