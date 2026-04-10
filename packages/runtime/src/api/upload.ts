import { constants } from "node:http2";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extract as tarExtract } from "tar-stream";
import type { WorkflowRegistry } from "../workflow-registry.js";

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

function createUploadHandler(registry: WorkflowRegistry) {
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

		const name = await registry.register(files);
		if (!name) {
			return c.json(
				{ error: "Invalid workflow bundle" },
				HTTP_UNPROCESSABLE_ENTITY,
			);
		}

		return c.body(null, HTTP_NO_CONTENT);
	};
}

export { createUploadHandler, extractTarGz };
