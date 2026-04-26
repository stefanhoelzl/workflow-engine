import { upload as cliUpload } from "@workflow-engine/sdk/cli";

interface UploadFixtureOptions {
	cwd: string;
	url: string;
	owner: string;
	repo: string;
	user: string;
	// Hermetic env passed through to `bundle()`'s IIFE-eval VM and to its
	// secret-binding sealing pass. Mirrors what the framework already passed
	// to `buildFixture` so the cached build and the upload bundle agree on
	// what env was visible at build time.
	buildEnv?: Record<string, string>;
}

async function uploadFixture(opts: UploadFixtureOptions): Promise<void> {
	const result = await cliUpload({
		cwd: opts.cwd,
		url: opts.url,
		owner: opts.owner,
		repo: opts.repo,
		user: opts.user,
		...(opts.buildEnv === undefined ? {} : { env: opts.buildEnv }),
	});
	if (result.failed > 0) {
		throw new Error(
			`upload failed: ${String(result.failed)} of ${String(result.failed + result.uploaded)} bundles rejected`,
		);
	}
}

export type { UploadFixtureOptions };
export { uploadFixture };
