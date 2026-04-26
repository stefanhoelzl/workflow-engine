import { upload as cliUpload } from "@workflow-engine/sdk/cli";

interface UploadFixtureOptions {
	cwd: string;
	url: string;
	owner: string;
	repo: string;
	user: string;
}

async function uploadFixture(opts: UploadFixtureOptions): Promise<void> {
	const result = await cliUpload({
		cwd: opts.cwd,
		url: opts.url,
		owner: opts.owner,
		repo: opts.repo,
		user: opts.user,
	});
	if (result.failed > 0) {
		throw new Error(
			`upload failed: ${String(result.failed)} of ${String(result.failed + result.uploaded)} bundles rejected`,
		);
	}
}

export type { UploadFixtureOptions };
export { uploadFixture };
