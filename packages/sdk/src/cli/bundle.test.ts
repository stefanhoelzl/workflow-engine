import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import {
	awaitCryptoReady,
	derivePublicKey,
	generateKeypair,
	unsealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import { extract as tarExtract } from "tar-stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { bundle } from "./bundle.js";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..", "..", "..", "..");

beforeAll(async () => {
	await awaitCryptoReady();
});

async function linkSdk(tempDir: string): Promise<void> {
	const { symlink } = await import("node:fs/promises");
	const nm = join(tempDir, "node_modules");
	const scoped = join(nm, "@workflow-engine");
	await mkdir(scoped, { recursive: true });
	const target = resolve(repoRoot, "packages", "sdk");
	await symlink(target, join(scoped, "sdk"), "dir");
}

async function makeFixture(
	files: Record<string, string>,
): Promise<{ cwd: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "wfe-bundle-"));
	await writeFile(
		join(cwd, "package.json"),
		JSON.stringify({ type: "module" }),
	);
	await linkSdk(cwd);
	await Promise.all(
		Object.entries(files).map(async ([rel, content]) => {
			const full = join(cwd, rel);
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, content, "utf8");
		}),
	);
	return { cwd };
}

async function readTarEntries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	const extractor = tarExtract();
	extractor.on("entry", (header, stream, next) => {
		const chunks: Buffer[] = [];
		stream.on("data", (c: Buffer) => chunks.push(c));
		stream.on("end", () => {
			out.set(header.name, Buffer.concat(chunks));
			next();
		});
		stream.resume();
	});
	await pipeline(
		Readable.from([Buffer.from(bytes)]),
		createGunzip(),
		extractor,
	);
	return out;
}

// We need to skip the typecheck path for bundle's internal buildWorkflows
// call. The simplest way is to mock buildWorkflows to return a known shape;
// bundle.ts then does its real seal+tar work.
vi.mock("./build-workflows.js", async () => {
	const actual = await vi.importActual<typeof import("./build-workflows.js")>(
		"./build-workflows.js",
	);
	return {
		...actual,
		buildWorkflows: vi.fn(async () => ({
			files: new Map<string, string>([
				["wf.js", "var __wfe_exports__ = (function(e){return e;})({});"],
			]),
			manifest: {
				workflows: [
					{
						name: "wf",
						module: "wf.js",
						sha: "0".repeat(64),
						env: {},
						actions: [],
						triggers: [],
					},
				],
			},
		})),
	};
});

describe("bundle()", () => {
	it("packs an in-memory tar containing manifest.json + per-workflow .js when no secrets", async () => {
		const { cwd } = await makeFixture({});
		const bytes = await bundle({
			cwd,
			url: "http://example.invalid",
			owner: "acme",
		});
		const entries = await readTarEntries(bytes);
		expect(entries.has("manifest.json")).toBe(true);
		expect(entries.has("wf.js")).toBe(true);
		const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
		expect(manifest.workflows[0].secretBindings).toBeUndefined();
		expect(manifest.workflows[0].secrets).toBeUndefined();
		expect(manifest.workflows[0].secretsKeyId).toBeUndefined();
	});

	it("does NOT fetch the pubkey when no workflow has secret bindings", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { cwd } = await makeFixture({});
		await bundle({
			cwd,
			url: "http://example.invalid",
			owner: "acme",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("fetches the pubkey, seals secrets, and emits a manifest with secrets + secretsKeyId", async () => {
		const buildWorkflowsModule = await import("./build-workflows.js");
		const buildWorkflowsSpy = vi.mocked(buildWorkflowsModule.buildWorkflows);
		buildWorkflowsSpy.mockResolvedValueOnce({
			files: new Map<string, string>([["wf.js", "/* runtime bundle */"]]),
			manifest: {
				workflows: [
					{
						name: "wf",
						module: "wf.js",
						sha: "0".repeat(64),
						env: {},
						actions: [],
						triggers: [],
						secretBindings: ["MY_TOKEN"],
					},
				],
			},
		});

		const sk = generateKeypair().secretKey;
		const pk = derivePublicKey(sk);
		const fakeKeyId = "deadbeefdeadbeef";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					algorithm: "x25519",
					publicKey: Buffer.from(pk).toString("base64"),
					keyId: fakeKeyId,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const { cwd } = await makeFixture({});
		const bytes = await bundle({
			cwd,
			url: "http://example.invalid",
			owner: "acme",
			env: { MY_TOKEN: "ghp_xxx" },
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const fetchUrl = fetchSpy.mock.calls[0]?.[0];
		expect(String(fetchUrl)).toBe(
			"http://example.invalid/api/workflows/acme/public-key",
		);

		const entries = await readTarEntries(bytes);
		const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
		const wf = manifest.workflows[0];
		expect(wf.secretBindings).toBeUndefined();
		expect(wf.secretsKeyId).toBe(fakeKeyId);
		expect(typeof wf.secrets.MY_TOKEN).toBe("string");

		// Server-side decrypt proves the seal matches.
		const ct = Uint8Array.from(Buffer.from(wf.secrets.MY_TOKEN, "base64"));
		const plaintext = unsealCiphertext(ct, pk, sk);
		expect(new TextDecoder().decode(plaintext)).toBe("ghp_xxx");

		fetchSpy.mockRestore();
	});

	it("fails fast with MissingSecretEnvError when env var for a binding is unset (no fetch)", async () => {
		const buildWorkflowsModule = await import("./build-workflows.js");
		const buildWorkflowsSpy = vi.mocked(buildWorkflowsModule.buildWorkflows);
		buildWorkflowsSpy.mockResolvedValueOnce({
			files: new Map<string, string>([["wf.js", "/* runtime bundle */"]]),
			manifest: {
				workflows: [
					{
						name: "wf",
						module: "wf.js",
						sha: "0".repeat(64),
						env: {},
						actions: [],
						triggers: [],
						secretBindings: ["MY_TOKEN"],
					},
				],
			},
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { cwd } = await makeFixture({});
		await expect(
			bundle({
				cwd,
				url: "http://example.invalid",
				owner: "acme",
				env: {},
			}),
		).rejects.toThrow(/Missing env vars for secret bindings: MY_TOKEN/);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
