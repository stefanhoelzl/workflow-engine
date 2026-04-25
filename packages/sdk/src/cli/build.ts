import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BuildWorkflowsError, buildWorkflows } from "./build-workflows.js";

class NoWorkflowsFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoWorkflowsFoundError";
	}
}

/**
 * `wfe build`: compiles workflows, runs the IIFE-eval discovery (env +
 * trigger validation, secret-binding detection), and writes ONLY the
 * per-workflow `.js` files to `<cwd>/dist/`. Does not write `manifest.json`
 * or `bundle.tar.gz`. Does not perform any network I/O.
 *
 * The deployable tenant tarball is produced by `bundle()` (called from
 * `wfe upload`), not here.
 */
async function build(options: { cwd: string }): Promise<void> {
	let result: Awaited<ReturnType<typeof buildWorkflows>>;
	try {
		result = await buildWorkflows({ cwd: options.cwd });
	} catch (error) {
		if (
			error instanceof BuildWorkflowsError &&
			error.message.startsWith("no workflows found")
		) {
			throw new NoWorkflowsFoundError(error.message);
		}
		throw error;
	}
	const distDir = join(options.cwd, "dist");
	await mkdir(distDir, { recursive: true });
	await Promise.all(
		Array.from(result.files, ([name, content]) =>
			writeFile(join(distDir, name), content, "utf8"),
		),
	);
}

export { build, NoWorkflowsFoundError };
