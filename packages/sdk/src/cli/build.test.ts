import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build, NoWorkflowsFoundError } from "./build.js";

// Happy-path (produces dist/bundle.tar.gz from a valid workflow) is covered
// by `packages/sdk/src/plugin/workflow-build.test.ts` at the plugin layer and
// by `pnpm -r build` against `workflows/` (which this file's `build()` wraps
// unchanged). These tests guard the two CLI-level error paths consumed by the
// `wfe build` subcommand: missing/empty `src/`.

describe("build() — error paths consumed by `wfe build`", () => {
	it("throws NoWorkflowsFoundError when src/ exists but is empty", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "wfe-build-test-"));
		await mkdir(join(cwd, "src"), { recursive: true });

		await expect(build({ cwd })).rejects.toBeInstanceOf(NoWorkflowsFoundError);
	});

	it("throws NoWorkflowsFoundError when src/ is missing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "wfe-build-test-"));

		await expect(build({ cwd })).rejects.toBeInstanceOf(NoWorkflowsFoundError);
	});
});
