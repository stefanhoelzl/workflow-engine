import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger.js";
import { createFsStorage } from "./storage/fs.js";
import {
	createWorkflowRegistry,
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
			schema: { type: "object" },
		},
	],
};

const VALID_TENANT_MANIFEST = { workflows: [VALID_WORKFLOW] };

const BUNDLE_SOURCE = "/* bundle placeholder */";

function tenantFiles(): Map<string, string> {
	return new Map([
		["manifest.json", JSON.stringify(VALID_TENANT_MANIFEST)],
		["demo.js", BUNDLE_SOURCE],
	]);
}

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

describe("workflow registry", () => {
	let registry: WorkflowRegistry;

	afterEach(() => {
		registry?.dispose();
	});

	it("registers a tenant and exposes its metadata via list/lookup", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const result = await registry.registerTenant("acme", tenantFiles());
		expect(result.ok).toBe(true);
		expect(registry.tenants()).toEqual(["acme"]);

		const entries = registry.list("acme");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.tenant).toBe("acme");
		expect(entries[0]?.workflow.name).toBe("demo");
		expect(entries[0]?.bundleSource).toBe(BUNDLE_SOURCE);

		const lookup = registry.lookup("acme", "demo", "ping", "POST");
		expect(lookup?.workflow.name).toBe("demo");
		expect(lookup?.triggerName).toBe("onPing");
		expect(lookup?.bundleSource).toBe(BUNDLE_SOURCE);
	});

	it("returns undefined for wrong method / wrong path / wrong tenant", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());

		expect(registry.lookup("acme", "demo", "ping", "GET")).toBeUndefined();
		expect(registry.lookup("acme", "demo", "other", "POST")).toBeUndefined();
		expect(
			registry.lookup("other-tenant", "demo", "ping", "POST"),
		).toBeUndefined();
	});

	it("same workflow name in two tenants is isolated by tenant", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		await registry.registerTenant("contoso", tenantFiles());
		expect(registry.tenants().sort()).toEqual(["acme", "contoso"]);
		expect(registry.lookup("acme", "demo", "ping", "POST")).toBeDefined();
		expect(registry.lookup("contoso", "demo", "ping", "POST")).toBeDefined();
		expect(registry.lookup("other", "demo", "ping", "POST")).toBeUndefined();
	});

	it("re-registering a tenant atomically replaces its workflow set", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		expect(registry.list("acme")).toHaveLength(1);
		// Re-upload with an empty workflow set clears the tenant's workflows.
		const empty = new Map([
			["manifest.json", JSON.stringify({ workflows: [] })],
		]);
		await registry.registerTenant("acme", empty);
		expect(registry.list("acme")).toHaveLength(0);
		expect(registry.lookup("acme", "demo", "ping", "POST")).toBeUndefined();
	});

	it("rejects upload when a referenced workflow module is missing (all-or-nothing)", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		// First upload succeeds
		await registry.registerTenant("acme", tenantFiles());

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
		const result = await registry.registerTenant("acme", broken);
		expect(result.ok).toBe(false);
		expect(registry.list("acme")).toHaveLength(1);
		expect(registry.list("acme")[0]?.workflow.name).toBe("demo");
	});

	it("rejects upload with missing manifest.json", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const result = await registry.registerTenant("acme", new Map());
		expect(result.ok).toBe(false);
	});

	it("rejects upload with invalid manifest", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const result = await registry.registerTenant(
			"acme",
			new Map([["manifest.json", "{ not json"]]),
		);
		expect(result.ok).toBe(false);
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

	it("persists the tenant tarball to workflows/<tenant>.tar.gz when tarballBytes are provided", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();
		registry = createWorkflowRegistry({ logger, storageBackend: backend });

		const files = tenantFiles();
		const tarballBytes = await packTenantBundle(files);
		const result = await registry.registerTenant("acme", files, {
			tarballBytes,
		});
		expect(result.ok).toBe(true);

		const keys: string[] = [];
		for await (const k of backend.list("workflows/")) {
			keys.push(k);
		}
		expect(keys).toEqual(["workflows/acme.tar.gz"]);
	});

	it("recover() loads persisted tenants from storage at startup", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		const files = tenantFiles();
		const tarballBytes = await packTenantBundle(files);
		await backend.writeBytes("workflows/acme.tar.gz", tarballBytes);

		registry = createWorkflowRegistry({ logger, storageBackend: backend });
		await registry.recover();

		expect(registry.tenants()).toEqual(["acme"]);
		expect(registry.list("acme")).toHaveLength(1);
	});

	it("recover() skips non-.tar.gz keys and handles unreadable tarballs gracefully", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		const validFiles = tenantFiles();
		const validBytes = await packTenantBundle(validFiles);
		await backend.writeBytes("workflows/acme.tar.gz", validBytes);
		await backend.writeBytes(
			"workflows/broken.tar.gz",
			new Uint8Array([1, 2, 3]),
		);
		// Stray non-tarball key — must be ignored.
		await backend.write("workflows/readme.txt", "noop");

		registry = createWorkflowRegistry({ logger, storageBackend: backend });
		await registry.recover();

		expect(registry.tenants()).toEqual(["acme"]);
	});
});
