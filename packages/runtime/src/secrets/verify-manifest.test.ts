import type { Manifest, WorkflowManifest } from "@workflow-engine/core";
import {
	derivePublicKey,
	generateKeypair,
	sealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeManifest, makeWorkflowManifest } from "../test-utils/manifest.js";
import { createKeyStore, readyCrypto } from "./key-store.js";
import { verifyManifestSecrets } from "./verify-manifest.js";

beforeAll(async () => {
	await readyCrypto();
});

function makeCsv(sk: Uint8Array): string {
	return `k1:${Buffer.from(sk).toString("base64")}`;
}

function baseManifest(workflowOverrides: Partial<WorkflowManifest>): Manifest {
	return makeManifest({
		workflows: [makeWorkflowManifest({ sha: "sha", ...workflowOverrides })],
	});
}

describe("verifyManifestSecrets", () => {
	it("returns null for a manifest with no secrets", () => {
		const store = createKeyStore(makeCsv(generateKeypair().secretKey));
		const result = verifyManifestSecrets(baseManifest({}), store);
		expect(result).toBeNull();
	});

	it("returns null for valid ciphertext + keyId", () => {
		const sk = generateKeypair().secretKey;
		const pk = derivePublicKey(sk);
		const store = createKeyStore(makeCsv(sk));
		const { keyId } = store.getPrimary();
		const ct = sealCiphertext("hi", pk);
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
		const store = createKeyStore(makeCsv(generateKeypair().secretKey));
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
		const sk = generateKeypair().secretKey;
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
		const sk1 = generateKeypair().secretKey;
		const pk2 = derivePublicKey(generateKeypair().secretKey);
		const store = createKeyStore(makeCsv(sk1));
		const primary = store.getPrimary();

		const ct = sealCiphertext("x", pk2);
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
		const sk = generateKeypair().secretKey;
		const store = createKeyStore(makeCsv(sk));
		const primary = store.getPrimary();
		const manifest = makeManifest({
			workflows: [
				makeWorkflowManifest({
					name: "wf1",
					module: "wf1.js",
					sha: "s1",
					secrets: { A: "AAAA" },
					secretsKeyId: primary.keyId,
				}),
				makeWorkflowManifest({
					name: "wf2",
					module: "wf2.js",
					sha: "s2",
					secrets: { B: "BBBB" },
					secretsKeyId: primary.keyId,
				}),
			],
		});
		const result = verifyManifestSecrets(manifest, store);
		expect(result).toEqual({
			kind: "secret_decrypt_failed",
			workflow: "wf1",
			envName: "A",
		});
	});
});
