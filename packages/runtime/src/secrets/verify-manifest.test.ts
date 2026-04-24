import type { Manifest } from "@workflow-engine/core";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { createKeyStore, readySodium } from "./key-store.js";
import { verifyManifestSecrets } from "./verify-manifest.js";

beforeAll(async () => {
	await readySodium();
});

function makeCsv(sk: Uint8Array): string {
	return `k1:${Buffer.from(sk).toString("base64")}`;
}

function baseManifest(workflowOverrides: Record<string, unknown>): Manifest {
	return {
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: {},
				actions: [],
				triggers: [],
				...workflowOverrides,
			} as Manifest["workflows"][number],
		],
	};
}

describe("verifyManifestSecrets", () => {
	it("returns null for a manifest with no secrets", () => {
		const store = createKeyStore(makeCsv(sodium.randombytes_buf(32)));
		const result = verifyManifestSecrets(baseManifest({}), store);
		expect(result).toBeNull();
	});

	it("returns null for valid ciphertext + keyId", () => {
		const sk = sodium.randombytes_buf(32);
		const pk = sodium.crypto_scalarmult_base(sk);
		const store = createKeyStore(makeCsv(sk));
		const { keyId } = store.getPrimary();
		const ct = sodium.crypto_box_seal(new TextEncoder().encode("hi"), pk);
		const result = verifyManifestSecrets(
			baseManifest({
				secrets: { TOKEN: Buffer.from(ct).toString("base64") },
				secretsKeyId: keyId,
			}),
			store,
		);
		expect(result).toBeNull();
	});

	it("returns unknown_secret_key_id when keyId isn't in the store", () => {
		const store = createKeyStore(makeCsv(sodium.randombytes_buf(32)));
		const result = verifyManifestSecrets(
			baseManifest({
				secrets: { TOKEN: "AAAA" },
				secretsKeyId: "ffffffffffffffff",
			}),
			store,
		);
		expect(result).toEqual({
			kind: "unknown_secret_key_id",
			workflow: "wf",
			keyId: "ffffffffffffffff",
		});
	});

	it("returns secret_decrypt_failed when ciphertext is garbage", () => {
		const sk = sodium.randombytes_buf(32);
		const store = createKeyStore(makeCsv(sk));
		const primary = store.getPrimary();
		const result = verifyManifestSecrets(
			baseManifest({
				secrets: { TOKEN: "AAAA" },
				secretsKeyId: primary.keyId,
			}),
			store,
		);
		expect(result).toEqual({
			kind: "secret_decrypt_failed",
			workflow: "wf",
			envName: "TOKEN",
		});
	});

	it("returns secret_decrypt_failed when ct is sealed with a different pk", () => {
		const sk1 = sodium.randombytes_buf(32);
		const pk2 = sodium.crypto_scalarmult_base(sodium.randombytes_buf(32));
		const store = createKeyStore(makeCsv(sk1));
		const primary = store.getPrimary();

		const ct = sodium.crypto_box_seal(new TextEncoder().encode("x"), pk2);
		const result = verifyManifestSecrets(
			baseManifest({
				secrets: { TOKEN: Buffer.from(ct).toString("base64") },
				secretsKeyId: primary.keyId,
			}),
			store,
		);
		expect(result?.kind).toBe("secret_decrypt_failed");
	});

	it("reports the first failing workflow + envName", () => {
		const sk = sodium.randombytes_buf(32);
		const store = createKeyStore(makeCsv(sk));
		const primary = store.getPrimary();
		const manifest: Manifest = {
			workflows: [
				{
					name: "wf1",
					module: "wf1.js",
					sha: "s1",
					env: {},
					actions: [],
					triggers: [],
					secrets: { A: "AAAA" },
					secretsKeyId: primary.keyId,
				},
				{
					name: "wf2",
					module: "wf2.js",
					sha: "s2",
					env: {},
					actions: [],
					triggers: [],
					secrets: { B: "BBBB" },
					secretsKeyId: primary.keyId,
				},
			],
		};
		const result = verifyManifestSecrets(manifest, store);
		expect(result).toEqual({
			kind: "secret_decrypt_failed",
			workflow: "wf1",
			envName: "A",
		});
	});
});
