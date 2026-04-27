import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Hono } from "hono";
import { pack as tarPack } from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../auth/providers/index.js";
import { localProviderFactory } from "../auth/providers/local.js";
import { createEventStore } from "../event-bus/event-store.js";
import { createEventBus } from "../event-bus/index.js";
import type { Executor } from "../executor/index.js";
import type { SecretsKeyStore } from "../secrets/index.js";
import type { TriggerSource } from "../triggers/source.js";
import { createWorkflowRegistry } from "../workflow-registry.js";
import { apiMiddleware } from "./index.js";

const stubKeyStore: SecretsKeyStore = {
	getPrimary: () => ({
		keyId: "0000000000000000",
		pk: new Uint8Array(32),
		sk: new Uint8Array(32),
	}),
	lookup: () => undefined,
	allKeyIds: () => ["0000000000000000"],
};

// ---------------------------------------------------------------------------
// POST /api/workflows/:owner error-classification tests
// ---------------------------------------------------------------------------
// Covers 422 (manifest/unknown-kind), 400 (backend {ok:false}), 500
// (backend throws), and 400+infra_errors (both). See openspec
// changes/generalize-trigger-backends/specs/action-upload/spec.md.
//
// Auth: tests use the local provider with `local:acme`, so a user named
// `acme` is a member of the `acme` owner (owner === user.name path).

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
	fail: vi.fn(async () => undefined),
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

async function packOwnerBundle(
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
	return packOwnerBundle(
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

async function mountWithBackends(backends: readonly TriggerSource[]) {
	const authRegistry = buildRegistry("local:acme", [localProviderFactory], {
		secureCookies: false,
		nowFn: () => Date.now(),
	});
	const registry = createWorkflowRegistry({
		logger,
		executor: stubExecutor,
		backends,
		keyStore: stubKeyStore,
	});
	const eventStore = await createEventStore();
	const bus = createEventBus([eventStore], { logger });
	const middleware = apiMiddleware({
		authRegistry,
		registry,
		logger,
		keyStore: stubKeyStore,
		bus,
		eventStore,
	});
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	return { app, bus, eventStore };
}

const AUTH_HEADERS: Record<string, string> = {
	"x-auth-provider": "local",
	authorization: "User acme",
};

async function postUpload(
	app: Hono,
	owner: string,
	repo: string,
	body: Uint8Array,
): Promise<Response> {
	return app.request(`/api/workflows/${owner}/${repo}`, {
		method: "POST",
		body: body as unknown as BodyInit,
		headers: { ...AUTH_HEADERS, "Content-Type": "application/gzip" },
	});
}

describe("POST /api/workflows/:owner/:repo — error classification", () => {
	it("returns 204 on full-success across all backends", async () => {
		const { app } = await mountWithBackends([stubBackend("http", "ok")]);
		const res = await postUpload(app, "acme", "demo", await validBundle());
		expect(res.status).toBe(204);
	});

	it("returns 422 when the bundle is not a valid gzip/tar", async () => {
		const { app } = await mountWithBackends([stubBackend("http", "ok")]);
		const res = await app.request("/api/workflows/acme/demo", {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
			headers: { ...AUTH_HEADERS, "Content-Type": "application/gzip" },
		});
		// Invalid archive body -> 415
		expect(res.status).toBe(415);
	});

	it("returns 422 when the manifest references a Zod-unknown trigger type", async () => {
		const { app } = await mountWithBackends([stubBackend("http", "ok")]);
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
		const bundle = await packOwnerBundle(
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", "/* bundle */"],
			]),
		);
		const res = await postUpload(app, "acme", "demo", bundle);
		expect(res.status).toBe(422);
	});

	it("returns 422 when a Zod-valid kind has no registered backend (runtime allowlist)", async () => {
		const { app } = await mountWithBackends([stubBackend("http", "ok")]);
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
		const bundle = await packOwnerBundle(
			new Map([
				["manifest.json", JSON.stringify(cronOnlyManifest)],
				["demo.js", "/* bundle */"],
			]),
		);
		const res = await postUpload(app, "acme", "demo", bundle);
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error?: string };
		expect(body.error ?? "").toContain("unsupported trigger kind");
	});

	it("returns 400 with trigger_config_failed body when a backend reports user-config error", async () => {
		const { app } = await mountWithBackends([
			stubBackend("http", "userConfig"),
		]);
		const res = await postUpload(app, "acme", "demo", await validBundle());
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
		const { app } = await mountWithBackends([stubBackend("http", "infra")]);
		const res = await postUpload(app, "acme", "demo", await validBundle());
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
		const { app } = await mountWithBackends([
			stubBackend("http", "userConfig"),
			stubBackend("cron", "infra"),
		]);
		const res = await postUpload(app, "acme", "demo", await validBundle());
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

	it("returns 404 when an allow-listed user uploads to a non-member owner (cross-owner)", async () => {
		const { app } = await mountWithBackends([stubBackend("http", "ok")]);
		// The local provider's allow-list ("local:acme") means the
		// `acme` user's orgs are just [acme]. Uploading to `other` must fail
		// closed with the same 404 shape that owner-missing returns.
		const res = await postUpload(app, "other", "demo", await validBundle());
		expect(res.status).toBe(404);
	});

	it("returns 404 for a malformed repo identifier even when owner is valid", async () => {
		const { app } = await mountWithBackends([stubBackend("http", "ok")]);
		const bundle = (await validBundle()) as unknown as BodyInit;
		const res = await app.request("/api/workflows/acme/bad%20repo", {
			method: "POST",
			body: bundle,
			headers: { ...AUTH_HEADERS, "Content-Type": "application/gzip" },
		});
		expect(res.status).toBe(404);
	});
});

describe("POST /api/workflows/:owner/:repo — system.upload emission", () => {
	function manifestWith(
		workflows: Array<{ name: string; sha: string }>,
	): Record<string, unknown> {
		return {
			workflows: workflows.map(({ name, sha }) => ({
				name,
				module: `${name}.js`,
				sha,
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
			})),
		};
	}

	async function bundleOf(
		workflows: Array<{ name: string; sha: string }>,
	): Promise<Uint8Array> {
		const files = new Map<string, string>([
			["manifest.json", JSON.stringify(manifestWith(workflows))],
		]);
		for (const { name } of workflows) {
			files.set(`${name}.js`, `/* ${name} */`);
		}
		return packOwnerBundle(files);
	}

	async function listUploads(
		eventStore: Awaited<ReturnType<typeof createEventStore>>,
	): Promise<
		Array<{
			workflow: string;
			workflowSha: string;
			meta: unknown;
			input: unknown;
		}>
	> {
		const rows = await eventStore
			.query([{ owner: "acme", repo: "demo" }])
			.where("kind", "=", "system.upload")
			.selectAll()
			.execute();
		return rows.map((r) => ({
			workflow: r.workflow,
			workflowSha: r.workflowSha,
			meta: typeof r.meta === "string" ? JSON.parse(r.meta as string) : r.meta,
			input:
				typeof r.input === "string" ? JSON.parse(r.input as string) : r.input,
		}));
	}

	it("first-time upload of a 2-workflow bundle emits two system.upload events", async () => {
		const { app, eventStore } = await mountWithBackends([
			stubBackend("http", "ok"),
		]);
		const sha1 = "1".repeat(64);
		const sha2 = "2".repeat(64);
		const res = await postUpload(
			app,
			"acme",
			"demo",
			await bundleOf([
				{ name: "alpha", sha: sha1 },
				{ name: "beta", sha: sha2 },
			]),
		);
		expect(res.status).toBe(204);
		const uploads = await listUploads(eventStore);
		expect(uploads).toHaveLength(2);
		const byName = new Map(uploads.map((u) => [u.workflow, u]));
		expect(byName.get("alpha")?.workflowSha).toBe(sha1);
		expect(byName.get("beta")?.workflowSha).toBe(sha2);
		// dispatch user populated from authenticated session (local:acme)
		const dispatch = (
			byName.get("alpha")?.meta as {
				dispatch: { source: string; user: { login: string } };
			}
		).dispatch;
		expect(dispatch.source).toBe("upload");
		expect(dispatch.user.login).toBe("acme");
	});

	it("identical re-upload emits zero new system.upload events", async () => {
		const { app, eventStore } = await mountWithBackends([
			stubBackend("http", "ok"),
		]);
		const sha = "a".repeat(64);
		const bundle = await bundleOf([{ name: "alpha", sha }]);
		const r1 = await postUpload(app, "acme", "demo", bundle);
		expect(r1.status).toBe(204);
		expect(await listUploads(eventStore)).toHaveLength(1);
		const r2 = await postUpload(app, "acme", "demo", bundle);
		expect(r2.status).toBe(204);
		// still 1 — sha-deduped
		expect(await listUploads(eventStore)).toHaveLength(1);
	});

	it("mixed re-upload emits exactly one new event for the changed workflow", async () => {
		const { app, eventStore } = await mountWithBackends([
			stubBackend("http", "ok"),
		]);
		const oldSha = "a".repeat(64);
		const newSha = "b".repeat(64);
		const r1 = await postUpload(
			app,
			"acme",
			"demo",
			await bundleOf([
				{ name: "alpha", sha: oldSha },
				{ name: "beta", sha: oldSha },
			]),
		);
		expect(r1.status).toBe(204);
		expect(await listUploads(eventStore)).toHaveLength(2);

		// alpha unchanged, beta updated to newSha
		const r2 = await postUpload(
			app,
			"acme",
			"demo",
			await bundleOf([
				{ name: "alpha", sha: oldSha },
				{ name: "beta", sha: newSha },
			]),
		);
		expect(r2.status).toBe(204);
		const uploads = await listUploads(eventStore);
		expect(uploads).toHaveLength(3);
		// the one new event is the beta@newSha row
		const newRow = uploads.find(
			(u) => u.workflow === "beta" && u.workflowSha === newSha,
		);
		expect(newRow).toBeDefined();
	});

	it("emits no system.upload event when the upload returns 415 (invalid archive)", async () => {
		const { app, eventStore } = await mountWithBackends([
			stubBackend("http", "ok"),
		]);
		const res = await app.request("/api/workflows/acme/demo", {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
			headers: { ...AUTH_HEADERS, "Content-Type": "application/gzip" },
		});
		expect(res.status).toBe(415);
		expect(await listUploads(eventStore)).toHaveLength(0);
	});

	it("emits no system.upload event when the manifest fails validation (422)", async () => {
		const { app, eventStore } = await mountWithBackends([
			stubBackend("http", "ok"),
		]);
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
		const bundle = await packOwnerBundle(
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", "/* bundle */"],
			]),
		);
		const res = await postUpload(app, "acme", "demo", bundle);
		expect(res.status).toBe(422);
		expect(await listUploads(eventStore)).toHaveLength(0);
	});

	it("dedup gate works against a freshly bootstrapped event store (post-restart-equivalent)", async () => {
		// First "boot": upload, then drop the bus + eventStore. Persist
		// nothing — the dedup query reads from the same in-memory DuckDB so
		// to simulate restart we instead pre-populate a fresh store with the
		// expected event and verify the second upload skips emission.
		const sha = "c".repeat(64);

		const first = await mountWithBackends([stubBackend("http", "ok")]);
		await postUpload(
			first.app,
			"acme",
			"demo",
			await bundleOf([{ name: "alpha", sha }]),
		);
		expect(await listUploads(first.eventStore)).toHaveLength(1);

		// Second "boot" — fresh stack, but seed the eventStore with the
		// prior upload row before mounting the upload handler.
		const second = await mountWithBackends([stubBackend("http", "ok")]);
		await second.eventStore.handle({
			id: "evt_seedseedseed",
			seq: 0,
			ref: 0,
			at: new Date().toISOString(),
			ts: 0,
			kind: "system.upload",
			name: "alpha",
			owner: "acme",
			repo: "demo",
			workflow: "alpha",
			workflowSha: sha,
			input: {},
			meta: {
				dispatch: { source: "upload", user: { login: "acme", mail: "" } },
			},
		});
		expect(await listUploads(second.eventStore)).toHaveLength(1);

		// Same-sha re-upload on the rehydrated store: dedup-gate should
		// skip emission.
		await postUpload(
			second.app,
			"acme",
			"demo",
			await bundleOf([{ name: "alpha", sha }]),
		);
		expect(await listUploads(second.eventStore)).toHaveLength(1);
	});
});
