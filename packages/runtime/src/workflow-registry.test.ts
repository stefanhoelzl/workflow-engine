import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "./executor/index.js";
import type { Logger } from "./logger.js";
import { createFsStorage } from "./storage/fs.js";
import {
	createWorkflowRegistry,
	extractOwnerTarGz,
	type WorkflowRegistry,
} from "./workflow-registry.js";

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

function makeExecutor(): Executor {
	return {
		invoke: vi.fn(async () => ({ ok: true as const, output: {} })),
	};
}

const VALID_WORKFLOW = {
	name: "demo",
	module: "demo.js",
	sha: "0".repeat(64),
	env: {},
	actions: [
		{
			name: "doIt",
			input: { type: "object" },
			output: { type: "object" },
		},
	],
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
};

const VALID_OWNER_MANIFEST = { workflows: [VALID_WORKFLOW] };

const BUNDLE_SOURCE = "/* bundle placeholder */";

function ownerFiles(): Map<string, string> {
	return new Map([
		["manifest.json", JSON.stringify(VALID_OWNER_MANIFEST)],
		["demo.js", BUNDLE_SOURCE],
	]);
}

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

describe("workflow registry", () => {
	let registry: WorkflowRegistry;

	afterEach(() => {
		registry?.dispose();
	});

	it("registers a owner and exposes its metadata via list()", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		const result = await registry.registerOwner("acme", ownerFiles());
		expect(result.ok).toBe(true);
		expect(registry.owners()).toEqual(["acme"]);

		const entries = registry.list("acme");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.owner).toBe("acme");
		expect(entries[0]?.workflow.name).toBe("demo");
		expect(entries[0]?.bundleSource).toBe(BUNDLE_SOURCE);
		const triggers = entries[0]?.triggers ?? [];
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.kind).toBe("http");
		expect(triggers[0]?.name).toBe("onPing");
	});

	it("same workflow name in two owners is isolated by owner", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		await registry.registerOwner("acme", ownerFiles());
		await registry.registerOwner("contoso", ownerFiles());
		expect(registry.owners().sort()).toEqual(["acme", "contoso"]);
		expect(registry.list("acme")).toHaveLength(1);
		expect(registry.list("contoso")).toHaveLength(1);
		expect(registry.list("other")).toHaveLength(0);
	});

	it("re-registering a owner atomically replaces its workflow set", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		await registry.registerOwner("acme", ownerFiles());
		expect(registry.list("acme")).toHaveLength(1);
		// Re-upload with an empty workflow set clears the owner's workflows.
		const empty = new Map([
			["manifest.json", JSON.stringify({ workflows: [] })],
		]);
		await registry.registerOwner("acme", empty);
		expect(registry.list("acme")).toHaveLength(0);
	});

	it("rejects upload when a referenced workflow module is missing (all-or-nothing)", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		// First upload succeeds
		await registry.registerOwner("acme", ownerFiles());

		// Second upload has a broken workflow — entire upload must fail,
		// existing state must survive
		const broken = new Map([
			[
				"manifest.json",
				JSON.stringify({
					workflows: [{ ...VALID_WORKFLOW, module: "missing.js" }],
				}),
			],
		]);
		const result = await registry.registerOwner("acme", broken);
		expect(result.ok).toBe(false);
		expect(registry.list("acme")).toHaveLength(1);
		expect(registry.list("acme")[0]?.workflow.name).toBe("demo");
	});

	it("rejects upload with missing manifest.json", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		const result = await registry.registerOwner("acme", new Map());
		expect(result.ok).toBe(false);
	});

	it("rejects upload with invalid manifest", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		const result = await registry.registerOwner(
			"acme",
			new Map([["manifest.json", "{ not json"]]),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects upload with cron trigger having a malformed schedule", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		const badManifest = {
			workflows: [
				{
					...VALID_WORKFLOW,
					triggers: [
						{
							name: "bad",
							type: "cron",
							schedule: "not-a-cron",
							tz: "UTC",
							inputSchema: { type: "object" },
							outputSchema: {},
						},
					],
				},
			],
		};
		const result = await registry.registerOwner(
			"acme",
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects upload with cron trigger having an unknown timezone", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		const badManifest = {
			workflows: [
				{
					...VALID_WORKFLOW,
					triggers: [
						{
							name: "bad",
							type: "cron",
							schedule: "0 9 * * *",
							tz: "Not/AZone",
							inputSchema: { type: "object" },
							outputSchema: {},
						},
					],
				},
			],
		};
		const result = await registry.registerOwner(
			"acme",
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(false);
	});

	it("accepts upload with a valid cron trigger", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger, executor: makeExecutor() });
		const goodManifest = {
			workflows: [
				{
					...VALID_WORKFLOW,
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
		const result = await registry.registerOwner(
			"acme",
			new Map([
				["manifest.json", JSON.stringify(goodManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(true);
		expect(registry.list("acme")).toHaveLength(1);
	});
});

describe("extractOwnerTarGz: decompressed size cap", () => {
	it("rejects tarballs whose decompressed content exceeds the cap", async () => {
		// Highly compressible payload (~11 MiB of zero bytes) compresses to ~10 KiB
		// but decompresses past the 10 MiB cap.
		const BYTES_PER_MIB = 1024 * 1024;
		const bigFile = Buffer.alloc(11 * BYTES_PER_MIB, 0);
		const packed = await packOwnerBundle(
			new Map<string, string>([
				["manifest.json", JSON.stringify(VALID_OWNER_MANIFEST)],
				["demo.js", BUNDLE_SOURCE],
				["big.bin", bigFile.toString("utf-8")],
			]),
		);

		await expect(extractOwnerTarGz(packed)).rejects.toThrow();
	});
});

describe("workflow registry: persistence and recovery", () => {
	let storageDir: string;
	let registry: WorkflowRegistry;

	beforeEach(async () => {
		storageDir = await mkdtemp(join(tmpdir(), "wf-persist-"));
	});

	afterEach(async () => {
		registry?.dispose();
		await rm(storageDir, { recursive: true, force: true });
	});

	it("persists the owner tarball to workflows/<owner>.tar.gz when tarballBytes are provided", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			storageBackend: backend,
		});

		const files = ownerFiles();
		const tarballBytes = await packOwnerBundle(files);
		const result = await registry.registerOwner("acme", files, {
			tarballBytes,
		});
		expect(result.ok).toBe(true);

		const keys: string[] = [];
		for await (const k of backend.list("workflows/")) {
			keys.push(k);
		}
		expect(keys).toEqual(["workflows/acme.tar.gz"]);
	});

	it("recover() loads persisted owners from storage at startup", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		const files = ownerFiles();
		const tarballBytes = await packOwnerBundle(files);
		await backend.writeBytes("workflows/acme.tar.gz", tarballBytes);

		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			storageBackend: backend,
		});
		await registry.recover();

		expect(registry.owners()).toEqual(["acme"]);
		expect(registry.list("acme")).toHaveLength(1);
	});

	it("recover() skips non-.tar.gz keys and handles unreadable tarballs gracefully", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		const validFiles = ownerFiles();
		const validBytes = await packOwnerBundle(validFiles);
		await backend.writeBytes("workflows/acme.tar.gz", validBytes);
		await backend.writeBytes(
			"workflows/broken.tar.gz",
			new Uint8Array([1, 2, 3]),
		);
		// Stray non-tarball key — must be ignored.
		await backend.write("workflows/readme.txt", "noop");

		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			storageBackend: backend,
		});
		await registry.recover();

		expect(registry.owners()).toEqual(["acme"]);
	});
});

describe("workflow registry: backend reconfigure aggregation", () => {
	// Stub TriggerSource that can be scripted to return ok, userConfig, or throw.
	// Builds against the public interface without reaching into any concrete
	// backend (http/cron) so the tests focus on the aggregation contract.
	interface StubBackend {
		readonly source: import("./triggers/source.js").TriggerSource;
		readonly calls: Array<{
			owner: string;
			entries: readonly import("./triggers/source.js").TriggerEntry[];
		}>;
	}

	function stubBackend(
		kind: string,
		mode: "ok" | "userConfig" | "infra",
	): StubBackend {
		const calls: StubBackend["calls"] = [];
		const source: import("./triggers/source.js").TriggerSource = {
			kind,
			async start() {},
			async stop() {},
			async reconfigure(owner, entries) {
				calls.push({ owner, entries });
				if (mode === "infra") {
					throw new Error("backend unreachable");
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
		return { source, calls };
	}

	it("reconfigures every registered backend on a successful upload (even if a kind has no triggers)", async () => {
		const logger = makeLogger();
		const http = stubBackend("http", "ok");
		const cron = stubBackend("cron", "ok");
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			backends: [http.source, cron.source],
		});
		await registry.registerOwner("acme", ownerFiles());
		expect(http.calls).toHaveLength(1);
		expect(cron.calls).toHaveLength(1);
		// Cron gets an empty slice since the fixture has only http triggers.
		expect(cron.calls[0]?.entries).toHaveLength(0);
		expect(http.calls[0]?.entries).toHaveLength(1);
	});

	it("returns 400-shaped failure when one backend returns {ok: false}", async () => {
		const logger = makeLogger();
		const http = stubBackend("http", "userConfig");
		const cron = stubBackend("cron", "ok");
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			backends: [http.source, cron.source],
		});
		const result = await registry.registerOwner("acme", ownerFiles());
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		expect(result.error).toBe("trigger_config_failed");
		expect(result.userErrors?.length).toBe(1);
		expect(result.infraErrors).toBeUndefined();
	});

	it("returns 500-shaped failure when one backend throws", async () => {
		const logger = makeLogger();
		const http = stubBackend("http", "infra");
		const cron = stubBackend("cron", "ok");
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			backends: [http.source, cron.source],
		});
		const result = await registry.registerOwner("acme", ownerFiles());
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		expect(result.error).toBe("trigger_backend_failed");
		expect(result.infraErrors?.length).toBe(1);
		expect(result.userErrors).toBeUndefined();
	});

	it("returns both classes when a user-config error and an infra error occur together", async () => {
		const logger = makeLogger();
		const http = stubBackend("http", "userConfig");
		const cron = stubBackend("cron", "infra");
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			backends: [http.source, cron.source],
		});
		const result = await registry.registerOwner("acme", ownerFiles());
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		expect(result.error).toBe("trigger_config_failed");
		expect(result.userErrors?.length).toBe(1);
		expect(result.infraErrors?.length).toBe(1);
	});

	it("rejects a manifest that references an unknown trigger kind before calling any backend", async () => {
		const logger = makeLogger();
		const http = stubBackend("http", "ok");
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			backends: [http.source],
		});
		const badManifest = {
			workflows: [
				{
					...VALID_WORKFLOW,
					triggers: [
						{
							name: "unknownKind",
							type: "mail",
							inputSchema: { type: "object" },
							outputSchema: {},
						},
					],
				},
			],
		};
		const result = await registry.registerOwner(
			"acme",
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(false);
		expect(http.calls).toHaveLength(0);
	});

	it("does not persist the tarball when a backend reports failure", async () => {
		const storageDir = await mkdtemp(join(tmpdir(), "wf-no-persist-on-fail-"));
		try {
			const logger = makeLogger();
			const storage = createFsStorage(storageDir);
			await storage.init();
			const http = stubBackend("http", "userConfig");
			const registry = createWorkflowRegistry({
				logger,
				executor: makeExecutor(),
				backends: [http.source],
				storageBackend: storage,
			});
			const files = ownerFiles();
			const tarballBytes = await packOwnerBundle(files);
			const result = await registry.registerOwner("acme", files, {
				tarballBytes,
			});
			expect(result.ok).toBe(false);
			const keys: string[] = [];
			for await (const k of storage.list("workflows/")) {
				keys.push(k);
			}
			expect(keys).toHaveLength(0);
		} finally {
			await rm(storageDir, { recursive: true, force: true });
		}
	});
});
