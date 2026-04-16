import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Hono } from "hono";
import { pack as tarPack } from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowRegistry } from "../workflow-registry.js";
import { createUploadHandler, extractTarGz } from "./upload.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => logger),
};

const INVALID_MANIFEST_PREFIX = /^invalid manifest/;

// v1 manifest shape: { name, module, env, actions, triggers }.
const MANIFEST = {
	name: "test-workflow",
	module: "test-workflow.js",
	env: {},
	actions: [],
	triggers: [
		{
			name: "ping",
			type: "http",
			path: "ping",
			method: "POST",
			body: { type: "object" },
			params: [],
			schema: { type: "object" },
		},
	],
};

// Minimal valid bundle: declares a trigger export matching the manifest.
// The workflow-registry evaluates this inside a sandbox — keep it tiny
// and free of host dependencies.
const BUNDLE_SOURCE_V1 = `
const HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger");
const passThrough = { parse: (x) => x };
export const ping = Object.freeze({
	[HTTP_TRIGGER_BRAND]: true,
	path: "ping",
	method: "POST",
	body: passThrough,
	params: passThrough,
	query: undefined,
	handler: async () => ({ status: 200, body: "pong-v1" }),
});
`;

async function createGzipTar(files: Record<string, string>): Promise<Blob> {
	const packer = tarPack();
	for (const [name, content] of Object.entries(files)) {
		packer.entry({ name }, content);
	}
	packer.finalize();

	const chunks: Buffer[] = [];
	const gzip = createGzip();
	gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
	await pipeline(packer, gzip);

	return new Blob([Buffer.concat(chunks)]);
}

function createApp() {
	const registry = createWorkflowRegistry({ logger });
	const app = new Hono();
	app.post("/api/workflows", createUploadHandler({ registry, logger }));
	return { app, registry };
}

describe("extractTarGz", () => {
	it("extracts files from a gzip tar buffer", async () => {
		const blob = await createGzipTar({
			"manifest.json": '{"name":"test"}',
			"test.js": "code",
		});
		const files = await extractTarGz(await blob.arrayBuffer());
		expect(files.size).toBe(2);
		expect(files.get("manifest.json")).toBe('{"name":"test"}');
		expect(files.get("test.js")).toBe("code");
	});
});

describe("upload handler", () => {
	it("returns 204 and registers the workflow on a valid upload", async () => {
		const { app, registry } = createApp();
		const body = await createGzipTar({
			"manifest.json": JSON.stringify(MANIFEST),
			"test-workflow.js": BUNDLE_SOURCE_V1,
		});

		const res = await app.request("/api/workflows", {
			method: "POST",
			body,
		});

		expect(res.status).toBe(204);
		expect(registry.runners).toHaveLength(1);
		expect(registry.runners[0]?.name).toBe("test-workflow");
		expect(registry.triggerRegistry.size).toBe(1);
	});

	it("replaces an existing workflow on re-upload — old triggers removed", async () => {
		const { app, registry } = createApp();
		const upload = async (src: string) => {
			const body = await createGzipTar({
				"manifest.json": JSON.stringify(MANIFEST),
				"test-workflow.js": src,
			});
			return app.request("/api/workflows", { method: "POST", body });
		};

		await upload(BUNDLE_SOURCE_V1);
		expect(registry.runners).toHaveLength(1);
		expect(registry.triggerRegistry.size).toBe(1);

		const BUNDLE_SOURCE_V2 = BUNDLE_SOURCE_V1.replace("pong-v1", "pong-v2");
		await upload(BUNDLE_SOURCE_V2);
		expect(registry.runners).toHaveLength(1);
		// Trigger count stays at 1 (old registration is cleared before the
		// new one is added).
		expect(registry.triggerRegistry.size).toBe(1);

		// The new bundle's trigger handler should now respond with "pong-v2".
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("no runner after replace");
		}
		const result = await runner.invokeHandler("ping", {
			body: {},
			headers: {},
			url: "",
			method: "POST",
			params: {},
			query: {},
		});
		expect(result.body).toBe("pong-v2");
	});

	it("returns 415 with an error body for a non-gzip payload", async () => {
		const { app } = createApp();

		const res = await app.request("/api/workflows", {
			method: "POST",
			body: "not gzip",
		});

		expect(res.status).toBe(415);
		await expect(res.json()).resolves.toEqual({
			error: "Not a valid gzip/tar archive",
		});
	});

	it("returns 422 with a specific error when manifest.json is missing", async () => {
		const { app } = createApp();
		const body = await createGzipTar({
			"test-workflow.js": BUNDLE_SOURCE_V1,
		});

		const res = await app.request("/api/workflows", {
			method: "POST",
			body,
		});

		expect(res.status).toBe(422);
		await expect(res.json()).resolves.toEqual({
			error: "missing manifest.json",
		});
	});

	it("returns 422 with Zod issues when the manifest fails validation", async () => {
		const { app } = createApp();
		const body = await createGzipTar({
			"manifest.json": '{"invalid": true}',
		});

		const res = await app.request("/api/workflows", {
			method: "POST",
			body,
		});

		expect(res.status).toBe(422);
		const json = (await res.json()) as {
			error: string;
			issues?: Array<{ path: Array<string | number>; message: string }>;
		};
		expect(json.error).toMatch(INVALID_MANIFEST_PREFIX);
		expect(json.issues).toBeDefined();
		expect(json.issues?.length ?? 0).toBeGreaterThan(0);
	});

	it("returns 422 when the bundle file declared by the manifest is missing", async () => {
		const { app } = createApp();
		const body = await createGzipTar({
			"manifest.json": JSON.stringify(MANIFEST),
		});

		const res = await app.request("/api/workflows", {
			method: "POST",
			body,
		});

		expect(res.status).toBe(422);
		await expect(res.json()).resolves.toEqual({
			error: "missing action module: test-workflow.js",
		});
	});
});
