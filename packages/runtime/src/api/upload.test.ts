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
	child: vi.fn(),
};

const INVALID_MANIFEST_PREFIX = /^invalid manifest/;

const MANIFEST = {
	name: "test-workflow",
	module: "actions.js",
	events: [
		{
			name: "test.event",
			schema: { type: "object", properties: {}, required: [] },
		},
	],
	triggers: [],
	actions: [
		{
			name: "handle",
			export: "handle",
			on: "test.event",
			emits: [],
			env: {},
		},
	],
};

const ACTION_SOURCE = "export default async (ctx) => {}";

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
	app.post("/api/workflows", createUploadHandler(registry));
	return { app, registry };
}

describe("extractTarGz", () => {
	it("extracts files from tar.gz buffer", async () => {
		const blob = await createGzipTar({
			"manifest.json": '{"name":"test"}',
			"actions.js": "code",
		});
		const files = await extractTarGz(await blob.arrayBuffer());
		expect(files.size).toBe(2);
		expect(files.get("manifest.json")).toBe('{"name":"test"}');
		expect(files.get("actions.js")).toBe("code");
	});
});

describe("upload handler", () => {
	it("returns 204 for valid upload", async () => {
		const { app, registry } = createApp();
		const body = await createGzipTar({
			"manifest.json": JSON.stringify(MANIFEST),
			"actions.js": ACTION_SOURCE,
		});

		const res = await app.request("/api/workflows", {
			method: "POST",
			body,
		});

		expect(res.status).toBe(204);
		expect(registry.actions).toHaveLength(1);
		expect(registry.actions[0]?.name).toBe("handle");
	});

	it("returns 415 with error body for non-gzip body", async () => {
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

	it("returns 422 with specific error when manifest.json is missing", async () => {
		const { app } = createApp();
		const body = await createGzipTar({
			"actions.js": ACTION_SOURCE,
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

	it("returns 422 with issues when manifest fails validation", async () => {
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

	it("returns 422 with specific error when action source file is missing", async () => {
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
			error: "missing action module: actions.js",
		});
	});

	it("replaces existing workflow on re-upload", async () => {
		const { app, registry } = createApp();

		const upload = async (source: string) => {
			const body = await createGzipTar({
				"manifest.json": JSON.stringify(MANIFEST),
				"actions.js": source,
			});
			return app.request("/api/workflows", { method: "POST", body });
		};

		await upload("export default async () => { /* v1 */ }");
		expect(registry.actions[0]?.source).toContain("v1");

		await upload("export default async () => { /* v2 */ }");
		expect(registry.actions).toHaveLength(1);
		expect(registry.actions[0]?.source).toContain("v2");
	});
});
