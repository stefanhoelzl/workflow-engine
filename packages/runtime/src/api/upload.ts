import { constants } from "node:http2";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extract as tarExtract } from "tar-stream";
import type { Logger } from "../logger.js";
import {
	registerFromFiles,
	type WorkflowRegistry,
} from "../workflow-registry.js";

// ---------------------------------------------------------------------------
// POST /api/workflows — upload a single workflow bundle (v1)
// ---------------------------------------------------------------------------
//
// Payload: gzip-compressed tarball containing exactly the per-workflow
// output of the vite-plugin bundling step:
//   - manifest.json  (v1 ManifestSchema)
//   - <name>.js      (the bundled workflow source; `name` matches
//                     `manifest.module`)
//
// Flow:
//   1. Read body into an ArrayBuffer, pipe through gunzip + tar-stream.
//   2. Validate the tarball: reject unreadable streams with 415.
//   3. Call `registerFromFiles()` on the workflow registry — it validates
//      the manifest, loads the bundle into a new sandbox, and swaps in
//      the new workflow (or fails with a structured RegisterResult).
//   4. 204 on success; 422 + JSON body on validation / missing-module
//      failures (the registry's RegisterResult shape).
//
// SECURITY: this endpoint is mounted under `/api/*` and therefore
// inherits `githubAuthMiddleware` (see `api/index.ts`). Unauthenticated
// requests are rejected upstream and never reach this handler. The tar
// extractor is an in-memory accumulator — upload size is bounded by the
// HTTP server's max-body config.

const HTTP_NO_CONTENT =
	constants.HTTP_STATUS_NO_CONTENT as ContentfulStatusCode;
const HTTP_UNSUPPORTED_MEDIA_TYPE =
	constants.HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE as ContentfulStatusCode;
const HTTP_UNPROCESSABLE_ENTITY =
	constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode;

async function extractTarGz(buffer: ArrayBuffer): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const extractor = tarExtract();

	extractor.on("entry", (header, stream, next) => {
		if (header.type === "file") {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => {
				files.set(header.name, Buffer.concat(chunks).toString("utf-8"));
				next();
			});
		} else {
			stream.on("end", () => next());
			stream.resume();
		}
	});

	await pipeline(Readable.from(Buffer.from(buffer)), createGunzip(), extractor);

	return files;
}

interface UploadDeps {
	readonly registry: WorkflowRegistry;
	readonly logger: Logger;
}

function createUploadHandler(deps: UploadDeps) {
	return async (c: Context) => {
		const body = await c.req.arrayBuffer();

		let files: Map<string, string>;
		try {
			files = await extractTarGz(body);
		} catch {
			return c.json(
				{ error: "Not a valid gzip/tar archive" },
				HTTP_UNSUPPORTED_MEDIA_TYPE,
			);
		}

		const result = await registerFromFiles(deps.registry, files, {
			logger: deps.logger,
		});
		if (!result.ok) {
			const payload = result.issues
				? { error: result.error, issues: result.issues }
				: { error: result.error };
			return c.json(payload, HTTP_UNPROCESSABLE_ENTITY);
		}

		return c.body(null, HTTP_NO_CONTENT);
	};
}

export type { UploadDeps };
export { createUploadHandler, extractTarGz };
