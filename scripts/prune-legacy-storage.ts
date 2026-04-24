// One-shot cleanup for deploying the (owner, repo) split (see
// openspec/changes/add-per-repo-workflows/proposal.md §9).
//
// The pre-split layout keyed bundles by `workflows/<owner>.tar.gz` and stored
// per-invocation event data under `archive/<invocationId>.json` plus
// `pending/<invocationId>/<seq>.json`. All three prefixes become meaningless
// under the new schema (bundles are now repo-scoped, events now require
// `(owner, repo)` columns). Run this script against each environment's
// persistence backend BEFORE deploying the new code so startup recovery has
// nothing legacy to trip over.
//
// Usage: `pnpm tsx scripts/prune-legacy-storage.ts`.
// Respects the same env vars as the runtime's persistence factory
// (PERSISTENCE_PATH for fs, STORAGE_* for S2/S3). Idempotent: re-running on
// an already-pruned backend is a no-op.

import { resolve } from "node:path";
import { createFsStorage } from "../packages/runtime/src/storage/fs.js";
import type { StorageBackend } from "../packages/runtime/src/storage/index.js";
import { createS3Storage } from "../packages/runtime/src/storage/s3.js";

const PREFIXES = ["workflows/", "archive/", "pending/"] as const;

function selectBackend(): StorageBackend {
	const env = process.env;
	if (env.STORAGE_ENDPOINT || env.STORAGE_BUCKET) {
		const endpoint = env.STORAGE_ENDPOINT ?? "";
		const bucket = env.STORAGE_BUCKET ?? "";
		const region = env.STORAGE_REGION ?? "auto";
		const accessKeyId = env.STORAGE_ACCESS_KEY_ID ?? "";
		const secretAccessKey = env.STORAGE_SECRET_ACCESS_KEY ?? "";
		if (!(endpoint && bucket && accessKeyId && secretAccessKey)) {
			throw new Error(
				"S3-backed pruning requires STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY",
			);
		}
		return createS3Storage({
			endpoint,
			bucket,
			region,
			accessKeyId,
			secretAccessKey,
		});
	}
	const root = env.PERSISTENCE_PATH;
	if (!root) {
		throw new Error(
			"Local pruning requires PERSISTENCE_PATH (or provide STORAGE_* for S3)",
		);
	}
	return createFsStorage(resolve(root));
}

async function pruneOnce(backend: StorageBackend): Promise<void> {
	for (const prefix of PREFIXES) {
		let deleted = 0;
		for await (const key of backend.list(prefix)) {
			await backend.remove(key);
			deleted += 1;
		}
		console.error(`pruned ${String(deleted)} key(s) under "${prefix}"`);
	}
}

async function main(): Promise<void> {
	const backend = selectBackend();
	await backend.init();
	await pruneOnce(backend);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
