import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
	computeKeyId,
	encodeSentinel,
	type WorkflowManifest,
} from "@workflow-engine/core";
import sodium from "libsodium-wrappers";
import { pack as tarPack } from "tar-stream";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { Executor } from "./executor/index.js";
import type { Logger } from "./logger.js";
import type { SecretsKeyStore } from "./secrets/index.js";
import { createKeyStore, readySodium } from "./secrets/index.js";
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

// Test keystore: returns an unused primary key and throws on any lookup.
// Acceptable for tests whose manifests declare no `secrets`, because
// `decryptWorkflowSecrets` short-circuits to `{}` when `workflow.secrets` is
// undefined and the keystore is never consulted.
function makeKeyStore(): SecretsKeyStore {
	return {
		getPrimary: vi.fn(() => {
			throw new Error(
				"test keystore has no keys; test manifest must not declare `secrets`",
			);
		}),
		lookup: vi.fn(() => undefined),
		allKeyIds: vi.fn(() => []),
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
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		const result = await registry.registerOwner("acme", "demo", ownerFiles());
		expect(result.ok).toBe(true);
		expect(registry.owners()).toEqual(["acme"]);

		const entries = registry.list("acme", "demo");
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
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		await registry.registerOwner("acme", "demo", ownerFiles());
		await registry.registerOwner("contoso", "demo", ownerFiles());
		expect(registry.owners().sort()).toEqual(["acme", "contoso"]);
		expect(registry.list("acme", "demo")).toHaveLength(1);
		expect(registry.list("contoso", "demo")).toHaveLength(1);
		expect(registry.list("other", "demo")).toHaveLength(0);
	});

	it("sibling repos under the same owner coexist and are independently addressable", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		await registry.registerOwner("acme", "demo", ownerFiles());
		await registry.registerOwner("acme", "demo-advanced", ownerFiles());
		expect(registry.owners()).toEqual(["acme"]);
		expect(registry.repos("acme").sort()).toEqual(["demo", "demo-advanced"]);
		expect(registry.pairs()).toEqual([
			{ owner: "acme", repo: "demo" },
			{ owner: "acme", repo: "demo-advanced" },
		]);
		// Cross-repo workflow-name collision: identical manifest under both
		// repos must coexist because uniqueness is per-(owner, repo), not
		// per-owner.
		expect(registry.list("acme", "demo")).toHaveLength(1);
		expect(registry.list("acme", "demo-advanced")).toHaveLength(1);
		// Resolving a trigger requires the repo dimension to be specified.
		expect(registry.getEntry("acme", "demo", "demo", "onPing")).toBeDefined();
		expect(
			registry.getEntry("acme", "demo-advanced", "demo", "onPing"),
		).toBeDefined();
		// Sibling isolation: removing one repo leaves the other intact.
		const empty = new Map([
			["manifest.json", JSON.stringify({ workflows: [] })],
		]);
		await registry.registerOwner("acme", "demo", empty);
		expect(registry.list("acme", "demo")).toHaveLength(0);
		expect(registry.list("acme", "demo-advanced")).toHaveLength(1);
	});

	it("re-registering a owner atomically replaces its workflow set", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		await registry.registerOwner("acme", "demo", ownerFiles());
		expect(registry.list("acme", "demo")).toHaveLength(1);
		// Re-upload with an empty workflow set clears the owner's workflows.
		const empty = new Map([
			["manifest.json", JSON.stringify({ workflows: [] })],
		]);
		await registry.registerOwner("acme", "demo", empty);
		expect(registry.list("acme", "demo")).toHaveLength(0);
	});

	it("rejects upload when a referenced workflow module is missing (all-or-nothing)", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		// First upload succeeds
		await registry.registerOwner("acme", "demo", ownerFiles());

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
		const result = await registry.registerOwner("acme", "demo", broken);
		expect(result.ok).toBe(false);
		expect(registry.list("acme", "demo")).toHaveLength(1);
		expect(registry.list("acme", "demo")[0]?.workflow.name).toBe("demo");
	});

	it("rejects upload with missing manifest.json", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		const result = await registry.registerOwner("acme", "demo", new Map());
		expect(result.ok).toBe(false);
	});

	it("rejects upload with invalid manifest", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
		const result = await registry.registerOwner(
			"acme",
			"demo",
			new Map([["manifest.json", "{ not json"]]),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects upload with cron trigger having a malformed schedule", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
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
			"demo",
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects upload with cron trigger having an unknown timezone", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
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
			"demo",
			new Map([
				["manifest.json", JSON.stringify(badManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(false);
	});

	it("accepts upload with a valid cron trigger", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
		});
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
			"demo",
			new Map([
				["manifest.json", JSON.stringify(goodManifest)],
				["demo.js", BUNDLE_SOURCE],
			]),
		);
		expect(result.ok).toBe(true);
		expect(registry.list("acme", "demo")).toHaveLength(1);
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
			keyStore: makeKeyStore(),
			storageBackend: backend,
		});

		const files = ownerFiles();
		const tarballBytes = await packOwnerBundle(files);
		const result = await registry.registerOwner("acme", "demo", files, {
			tarballBytes,
		});
		expect(result.ok).toBe(true);

		const keys: string[] = [];
		for await (const k of backend.list("workflows/")) {
			keys.push(k);
		}
		expect(keys).toEqual(["workflows/acme/demo.tar.gz"]);
	});

	it("recover() loads persisted owners from storage at startup", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		const files = ownerFiles();
		const tarballBytes = await packOwnerBundle(files);
		await backend.writeBytes("workflows/acme/demo.tar.gz", tarballBytes);

		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
			storageBackend: backend,
		});
		await registry.recover();

		expect(registry.owners()).toEqual(["acme"]);
		expect(registry.list("acme", "demo")).toHaveLength(1);
	});

	it("recover() skips non-.tar.gz keys and handles unreadable tarballs gracefully", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		const validFiles = ownerFiles();
		const validBytes = await packOwnerBundle(validFiles);
		await backend.writeBytes("workflows/acme/demo.tar.gz", validBytes);
		await backend.writeBytes(
			"workflows/acme/broken.tar.gz",
			new Uint8Array([1, 2, 3]),
		);
		// Stray non-tarball key — must be ignored.
		await backend.write("workflows/acme/readme.txt", "noop");
		// Legacy depth-1 key — must be logged and skipped, not loaded.
		await backend.writeBytes("workflows/legacy-owner.tar.gz", validBytes);

		registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore: makeKeyStore(),
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
			repo: string;
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
			async reconfigure(owner, repo, entries) {
				calls.push({ owner, repo, entries });
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
			keyStore: makeKeyStore(),
			backends: [http.source, cron.source],
		});
		await registry.registerOwner("acme", "demo", ownerFiles());
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
			keyStore: makeKeyStore(),
			backends: [http.source, cron.source],
		});
		const result = await registry.registerOwner("acme", "demo", ownerFiles());
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
			keyStore: makeKeyStore(),
			backends: [http.source, cron.source],
		});
		const result = await registry.registerOwner("acme", "demo", ownerFiles());
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
			keyStore: makeKeyStore(),
			backends: [http.source, cron.source],
		});
		const result = await registry.registerOwner("acme", "demo", ownerFiles());
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
			keyStore: makeKeyStore(),
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
			"demo",
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
				keyStore: makeKeyStore(),
				backends: [http.source],
				storageBackend: storage,
			});
			const files = ownerFiles();
			const tarballBytes = await packOwnerBundle(files);
			const result = await registry.registerOwner("acme", "demo", files, {
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

// ---------------------------------------------------------------------------
// Trigger-config secret references — registration-time sentinel resolution.
// ---------------------------------------------------------------------------
//
// Covers the `workflow-secrets` capability's new requirement: sentinels in
// trigger descriptor string fields are substituted for decrypted plaintext
// before `TriggerSource.reconfigure` is called; missing names fail the
// workflow registration with `secret_ref_unresolved` and no backend state is
// changed. Integrates decryption (real libsodium), the registry walker, and
// the error-propagation path observed by `registerOwner`.

describe("registry — trigger-config secrets", () => {
	beforeAll(async () => {
		await readySodium();
	});

	function freshKeystore(): {
		keyStore: SecretsKeyStore;
		keyId: string;
		pk: Uint8Array;
	} {
		const sk = sodium.randombytes_buf(32);
		const pk = sodium.crypto_scalarmult_base(sk);
		const skB64 = Buffer.from(sk).toString("base64");
		const keyStore = createKeyStore(`primary:${skB64}`);
		return { keyStore, keyId: "placeholder", pk };
	}

	function sealValue(pk: Uint8Array, plaintext: string): string {
		return Buffer.from(sodium.crypto_box_seal(plaintext, pk)).toString(
			"base64",
		);
	}

	async function computeKeyIdB64(pk: Uint8Array): Promise<string> {
		return computeKeyId(pk);
	}

	function cronWorkflow(
		name: string,
		schedule: string,
		secretsKeyId: string | undefined,
		secrets: Record<string, string> | undefined,
	): WorkflowManifest {
		const wf: WorkflowManifest = {
			name,
			module: `${name}.js`,
			sha: "0".repeat(64),
			env: {},
			actions: [],
			triggers: [
				{
					name: "tick",
					type: "cron",
					schedule,
					tz: "UTC",
					inputSchema: { type: "object" },
					outputSchema: { type: "object" },
				},
			],
		};
		if (secretsKeyId && secrets) {
			(wf as unknown as Record<string, unknown>).secretsKeyId = secretsKeyId;
			(wf as unknown as Record<string, unknown>).secrets = secrets;
		}
		return wf;
	}

	it("resolves a cron-schedule sentinel to plaintext before reconfigure", async () => {
		const { keyStore, pk } = freshKeystore();
		const keyId = await computeKeyIdB64(pk);
		const plaintext = "*/5 * * * *";
		const workflow = cronWorkflow("demo", encodeSentinel("S"), keyId, {
			S: sealValue(pk, plaintext),
		});
		const manifest = { workflows: [workflow] };
		const files = new Map([
			["manifest.json", JSON.stringify(manifest)],
			["demo.js", BUNDLE_SOURCE],
		]);
		const logger = makeLogger();
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore,
		});
		try {
			const result = await registry.registerOwner("acme", "demo", files);
			expect(result.ok).toBe(true);
			const entries = registry.list("acme", "demo");
			expect(entries).toHaveLength(1);
			const descriptor = entries[0]?.triggers[0];
			if (!descriptor || descriptor.kind !== "cron") {
				throw new Error("expected cron descriptor");
			}
			expect(descriptor.schedule).toBe(plaintext);
			expect(descriptor.schedule).not.toContain("\x00secret:");
		} finally {
			registry.dispose();
		}
	});

	it("fails registration with secret_ref_unresolved when a sentinel has no matching secret", async () => {
		const { keyStore, pk } = freshKeystore();
		const keyId = await computeKeyIdB64(pk);
		// Manifest declares secret "S" but the trigger references "MISSING".
		const workflow = cronWorkflow("demo", encodeSentinel("MISSING"), keyId, {
			S: sealValue(pk, "irrelevant"),
		});
		const manifest = { workflows: [workflow] };
		const files = new Map([
			["manifest.json", JSON.stringify(manifest)],
			["demo.js", BUNDLE_SOURCE],
		]);
		const logger = makeLogger();
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore,
		});
		try {
			const result = await registry.registerOwner("acme", "demo", files);
			expect(result.ok).toBe(false);
			if (result.ok) {
				throw new Error("expected failure");
			}
			expect(result.error).toBe("secret_ref_unresolved");
			expect(result.secretFailures).toEqual([
				{ workflow: "demo", missing: ["MISSING"] },
			]);
			// Registry state unchanged — no entries registered.
			expect(registry.list("acme", "demo")).toHaveLength(0);
		} finally {
			registry.dispose();
		}
	});

	it("resolves substring sentinels inside a composed string", async () => {
		const { keyStore, pk } = freshKeystore();
		const keyId = await computeKeyIdB64(pk);
		// Use two sentinels that each individually form a valid cron field
		// sequence, so the resolved string is a valid 5-field cron. `A` is
		// "1,2,3" (minute list) and `B` is "*/2" (hour stride).
		const plaintextA = "1,2,3";
		const plaintextB = "*/2";
		const composedSchedule = `${encodeSentinel("A")} ${encodeSentinel("B")} * * *`;
		const workflow = cronWorkflow("demo", composedSchedule, keyId, {
			A: sealValue(pk, plaintextA),
			B: sealValue(pk, plaintextB),
		});
		const manifest = { workflows: [workflow] };
		const files = new Map([
			["manifest.json", JSON.stringify(manifest)],
			["demo.js", BUNDLE_SOURCE],
		]);
		const logger = makeLogger();
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore,
		});
		try {
			const result = await registry.registerOwner("acme", "demo", files);
			expect(result.ok).toBe(true);
			const descriptor = registry.list("acme", "demo")[0]?.triggers[0];
			if (!descriptor || descriptor.kind !== "cron") {
				throw new Error("expected cron descriptor");
			}
			expect(descriptor.schedule).toBe(`${plaintextA} ${plaintextB} * * *`);
			expect(descriptor.schedule).not.toContain("\x00secret:");
		} finally {
			registry.dispose();
		}
	});

	it("aggregates missing names across multiple workflows in one registration", async () => {
		const { keyStore, pk } = freshKeystore();
		const keyId = await computeKeyIdB64(pk);
		const wfA = cronWorkflow("wfA", encodeSentinel("MISS_A"), keyId, {
			S: sealValue(pk, "ignored"),
		});
		const wfB = cronWorkflow("wfB", encodeSentinel("MISS_B"), keyId, {
			S: sealValue(pk, "ignored"),
		});
		const manifest = { workflows: [wfA, wfB] };
		const files = new Map<string, string>([
			["manifest.json", JSON.stringify(manifest)],
			["wfA.js", BUNDLE_SOURCE],
			["wfB.js", BUNDLE_SOURCE],
		]);
		const logger = makeLogger();
		const registry = createWorkflowRegistry({
			logger,
			executor: makeExecutor(),
			keyStore,
		});
		try {
			const result = await registry.registerOwner("acme", "demo", files);
			expect(result.ok).toBe(false);
			if (result.ok) {
				throw new Error("expected failure");
			}
			expect(result.error).toBe("secret_ref_unresolved");
			const failures = [...(result.secretFailures ?? [])].sort((a, b) =>
				a.workflow.localeCompare(b.workflow),
			);
			expect(failures).toEqual([
				{ workflow: "wfA", missing: ["MISS_A"] },
				{ workflow: "wfB", missing: ["MISS_B"] },
			]);
		} finally {
			registry.dispose();
		}
	});
});
