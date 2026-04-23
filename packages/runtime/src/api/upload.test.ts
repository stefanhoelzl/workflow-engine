import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Hono } from "hono";
import { pack as tarPack } from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../auth/providers/index.js";
import { localProviderFactory } from "../auth/providers/local.js";
import type { Executor } from "../executor/index.js";
import type { TriggerSource } from "../triggers/source.js";
import { createWorkflowRegistry } from "../workflow-registry.js";
import { apiMiddleware } from "./index.js";

// ---------------------------------------------------------------------------
// POST /api/workflows/:tenant error-classification tests
// ---------------------------------------------------------------------------
// Covers 422 (manifest/unknown-kind), 400 (backend {ok:false}), 500
// (backend throws), and 400+infra_errors (both). See openspec
// changes/generalize-trigger-backends/specs/action-upload/spec.md.
//
// Auth: tests use the local provider with `local:acme`, so a user named
// `acme` is a member of the `acme` tenant (tenant === user.name path).

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => logger),
};

const stubExecutor: Executor = {
	invoke: vi.fn(async () => ({ ok: true as const, output: {} })),
};

const VALID_MANIFEST = {
	workflows: [
		{
			name: "demo",
			module: "demo.js",
			sha: "0".repeat(64),
			env: {},
			actions: [],
			triggers: [
				{
					name: "onPing",
					type: "http",
					path: "ping",
					method: "POST",
					body: { type: "object" },
					params: [],
					inputSchema: { type: "object" },
					outputSchema: { type: "object" },
				},
			],
		},
	],
};

async function packTenantBundle(
	files: Map<string, string>,
): Promise<Uint8Array> {
	const packer = tarPack();
	for (const [name, content] of files) {
		packer.entry({ name }, content);
	}
	packer.finalize();
	const chunks: Buffer[] = [];
	const gzip = createGzip();
	gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
	await pipeline(packer, gzip);
	const buf = Buffer.concat(chunks);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function validBundle(): Promise<Uint8Array> {
	return packTenantBundle(
		new Map([
			["manifest.json", JSON.stringify(VALID_MANIFEST)],
			["demo.js", "/* bundle */"],
		]),
	);
}

function stubBackend(
	kind: string,
	mode: "ok" | "userConfig" | "infra",
): TriggerSource {
	return {
		kind,
		async start() {},
		async stop() {},
		async reconfigure() {
			if (mode === "infra") {
				throw new Error(`backend ${kind} unreachable`);
			}
			if (mode === "userConfig") {
				return {
					ok: false,
					errors: [
						{
							backend: kind,
							trigger: "*",
							message: `bad config for ${kind}`,
						},
					],
				};
			}
			return { ok: true };
		},
	};
}

function mountWithBackends(backends: readonly TriggerSource[]) {
	const authRegistry = buildRegistry("local:acme", [localProviderFactory], {
		secureCookies: false,
		nowFn: () => Date.now(),
	});
	const registry = createWorkflowRegistry({
		logger,
		executor: stubExecutor,
		backends,
	});
	const middleware = apiMiddleware({ authRegistry, registry, logger });
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	return app;
}

const AUTH_HEADERS: Record<string, string> = {
	"x-auth-provider": "local",
	authorization: "User acme",
};

async function postUpload(
	app: Hono,
	tenant: string,
	body: Uint8Array,
): Promise<Response> {
	return app.request(`/api/workflows/${tenant}`, {
		method: "POST",
		body: body as unknown as BodyInit,
		headers: { ...AUTH_HEADERS, "Content-Type": "application/gzip" },
	});
}

describe("POST /api/workflows/:tenant — error classification", () => {
	it("returns 204 on full-success across all backends", async () => {
		const app = mountWithBackends([stubBackend("http", "ok")]);
		const res = await postUpload(app, "acme", await validBundle());
		expect(res.status).toBe(204);
	});

	it("returns 422 when the bundle is not a valid gzip/tar", async () => {
		const app = mountWithBackends([stubBackend("http", "ok")]);
		const res = await app.request("/api/workflows/acme", {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
			headers: { ...AUTH_HEADERS, "Content-Type": "application/gzip" },
		});
		// Invalid archive body -> 415
		expect(res.status).toBe(415);
	});

	it("returns 422 when the manifest references a Zod-unknown trigger type", async () => {
		const app = mountWithBackends([stubBackend("http", "ok")]);
		const badManifest = {
			workflows: [
				{
					...VALID_MANIFEST.workflows[0],
					triggers: [
						{
							name: "mailish",
							type: "mail",
							inputSchema: { type: "object" },
							outputSchema: {},
						},
					],
				},
			],
		};
		const bundle = await packTenantBundle(
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", "/* bundle */"],
			]),
		);
		const res = await postUpload(app, "acme", bundle);
		expect(res.status).toBe(422);
	});

	it("returns 422 when a Zod-valid kind has no registered backend (runtime allowlist)", async () => {
		const app = mountWithBackends([stubBackend("http", "ok")]);
		const cronOnlyManifest = {
			workflows: [
				{
					...VALID_MANIFEST.workflows[0],
					triggers: [
						{
							name: "daily",
							type: "cron",
							schedule: "0 9 * * *",
							tz: "UTC",
							inputSchema: { type: "object" },
							outputSchema: {},
						},
					],
				},
			],
		};
		const bundle = await packTenantBundle(
			new Map([
				["manifest.json", JSON.stringify(cronOnlyManifest)],
				["demo.js", "/* bundle */"],
			]),
		);
		const res = await postUpload(app, "acme", bundle);
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error?: string };
		expect(body.error ?? "").toContain("unsupported trigger kind");
	});

	it("returns 400 with trigger_config_failed body when a backend reports user-config error", async () => {
		const app = mountWithBackends([stubBackend("http", "userConfig")]);
		const res = await postUpload(app, "acme", await validBundle());
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: string;
			errors: Array<{ backend: string; trigger: string; message: string }>;
		};
		expect(body.error).toBe("trigger_config_failed");
		expect(body.errors.length).toBe(1);
		expect(body.errors[0]?.backend).toBe("http");
	});

	it("returns 500 with trigger_backend_failed body when a backend throws", async () => {
		const app = mountWithBackends([stubBackend("http", "infra")]);
		const res = await postUpload(app, "acme", await validBundle());
		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: string;
			errors: Array<{ backend: string; message: string }>;
		};
		expect(body.error).toBe("trigger_backend_failed");
		expect(body.errors.length).toBe(1);
		expect(body.errors[0]?.backend).toBe("http");
	});

	it("returns 400 with both errors and infra_errors when both classes fire", async () => {
		const app = mountWithBackends([
			stubBackend("http", "userConfig"),
			stubBackend("cron", "infra"),
		]);
		const res = await postUpload(app, "acme", await validBundle());
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: string;
			errors: Array<{ backend: string }>;
			infra_errors: Array<{ backend: string }>;
		};
		expect(body.error).toBe("trigger_config_failed");
		expect(body.errors.length).toBe(1);
		expect(body.errors[0]?.backend).toBe("http");
		expect(body.infra_errors.length).toBe(1);
		expect(body.infra_errors[0]?.backend).toBe("cron");
	});
});
