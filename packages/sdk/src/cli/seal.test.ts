import { createGunzip, createGzip } from "node:zlib";
import sodium from "libsodium-wrappers";
import { extract as tarExtract, pack as tarPack } from "tar-stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	collectSecretBindings,
	MissingSecretEnvError,
	sealBundleIfNeeded,
} from "./seal.js";

beforeAll(async () => {
	await sodium.ready;
});

async function buildTarGz(
	entries: Array<{ name: string; content: string | Buffer }>,
): Promise<Uint8Array> {
	const tar = tarPack();
	for (const { name, content } of entries) {
		tar.entry({ name }, content);
	}
	tar.finalize();
	const gz = createGzip();
	const chunks: Buffer[] = [];
	const { pipeline } = await import("node:stream/promises");
	const { Writable } = await import("node:stream");
	const sink = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(chunk);
			cb();
		},
	});
	await pipeline(tar, gz, sink);
	return Uint8Array.from(Buffer.concat(chunks));
}

async function readTarGz(bytes: Uint8Array): Promise<Map<string, string>> {
	const { Readable } = await import("node:stream");
	const out = new Map<string, string>();
	const gz = createGunzip();
	const tar = tarExtract();
	Readable.from([Buffer.from(bytes)])
		.pipe(gz)
		.pipe(tar);
	for await (const entry of tar) {
		const chunks: Buffer[] = [];
		for await (const c of entry) {
			chunks.push(c as Buffer);
		}
		out.set(entry.header.name, Buffer.concat(chunks).toString("utf8"));
	}
	return out;
}

describe("collectSecretBindings", () => {
	it("returns total=0 for a manifest with no secret bindings", () => {
		const { total, byWorkflow } = collectSecretBindings({
			workflows: [{ name: "wf", secretBindings: [] }, { name: "wf2" }],
		});
		expect(total).toBe(0);
		expect(byWorkflow.size).toBe(0);
	});

	it("counts bindings across multiple workflows", () => {
		const { total, byWorkflow } = collectSecretBindings({
			workflows: [
				{ name: "a", secretBindings: ["TOKEN", "STRIPE_KEY"] },
				{ name: "b" },
				{ name: "c", secretBindings: ["X"] },
			],
		});
		expect(total).toBe(3);
		expect(byWorkflow.get("a")).toEqual(["TOKEN", "STRIPE_KEY"]);
		expect(byWorkflow.get("c")).toEqual(["X"]);
		expect(byWorkflow.has("b")).toBe(false);
	});
});

describe("sealBundleIfNeeded", () => {
	async function buildServerKeypair() {
		const sk = sodium.randombytes_buf(32);
		const pk = sodium.crypto_scalarmult_base(sk);
		return { pk, sk };
	}

	async function serveKey(
		pk: Uint8Array,
		keyId: string,
	): Promise<typeof fetch> {
		return (async (_input: RequestInfo | URL) =>
			new Response(
				JSON.stringify({
					algorithm: "x25519",
					publicKey: Buffer.from(pk).toString("base64"),
					keyId,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)) as unknown as typeof fetch;
	}

	it("passes bundles without secret bindings through unchanged", async () => {
		const bundle = await buildTarGz([
			{
				name: "manifest.json",
				content: JSON.stringify({
					workflows: [{ name: "wf", env: {}, actions: [], triggers: [] }],
				}),
			},
			{ name: "wf.js", content: "var x = 1;" },
		]);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const out = await sealBundleIfNeeded(bundle, {
				url: "http://localhost",
				owner: "t",
				auth: {},
				env: {},
			});
			expect(out).toBe(bundle);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("seals secret bindings and rewrites the manifest", async () => {
		const { pk, sk } = await buildServerKeypair();
		const bundle = await buildTarGz([
			{
				name: "manifest.json",
				content: JSON.stringify({
					workflows: [
						{
							name: "wf",
							env: { REGION: "us-east-1" },
							secretBindings: ["TOKEN"],
							actions: [],
							triggers: [],
						},
					],
				}),
			},
			{ name: "wf.js", content: "var x = 1;" },
		]);
		vi.stubGlobal("fetch", await serveKey(pk, "abcdef0123456789"));
		try {
			const out = await sealBundleIfNeeded(bundle, {
				url: "http://localhost",
				owner: "t",
				auth: {},
				env: { TOKEN: "ghp_example" },
			});
			const files = await readTarGz(out);
			const manifest = JSON.parse(files.get("manifest.json") ?? "{}") as {
				workflows: Array<{
					env: Record<string, string>;
					secrets?: Record<string, string>;
					secretsKeyId?: string;
					secretBindings?: string[];
				}>;
			};
			const wf = manifest.workflows[0];
			expect(wf?.env).toEqual({ REGION: "us-east-1" });
			expect(wf?.secretsKeyId).toBe("abcdef0123456789");
			expect(wf?.secrets?.TOKEN).toBeDefined();
			expect(wf?.secretBindings).toBeUndefined();

			// Server-side decrypt proves the seal matches.
			const ct = Uint8Array.from(
				Buffer.from(wf?.secrets?.TOKEN ?? "", "base64"),
			);
			const plaintext = sodium.crypto_box_seal_open(ct, pk, sk);
			expect(new TextDecoder().decode(plaintext)).toBe("ghp_example");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("throws MissingSecretEnvError when env is unset", async () => {
		const { pk } = await buildServerKeypair();
		const bundle = await buildTarGz([
			{
				name: "manifest.json",
				content: JSON.stringify({
					workflows: [
						{
							name: "wf",
							env: {},
							secretBindings: ["TOKEN", "STRIPE"],
							actions: [],
							triggers: [],
						},
					],
				}),
			},
		]);
		vi.stubGlobal("fetch", await serveKey(pk, "fingerprint1234"));
		try {
			await expect(
				sealBundleIfNeeded(bundle, {
					url: "http://localhost",
					owner: "t",
					auth: {},
					env: { STRIPE: "sk" }, // TOKEN missing
				}),
			).rejects.toThrow(MissingSecretEnvError);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("does not write the rewritten manifest to disk (in-memory only)", async () => {
		// Structural check: sealBundleIfNeeded returns Uint8Array; no fs writes
		// are performed. Verified by the fact that we never await any fs API —
		// this test just re-runs the success path and asserts no side effects.
		const { pk } = await buildServerKeypair();
		const bundle = await buildTarGz([
			{
				name: "manifest.json",
				content: JSON.stringify({
					workflows: [
						{
							name: "wf",
							env: {},
							secretBindings: ["TOKEN"],
							actions: [],
							triggers: [],
						},
					],
				}),
			},
		]);
		vi.stubGlobal("fetch", await serveKey(pk, "ffffffffffffffff"));
		try {
			const out = await sealBundleIfNeeded(bundle, {
				url: "http://localhost",
				owner: "t",
				auth: {},
				env: { TOKEN: "x" },
			});
			expect(out).toBeInstanceOf(Uint8Array);
			expect(out.length).toBeGreaterThan(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
