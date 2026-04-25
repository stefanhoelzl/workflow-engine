import type { Manifest, WorkflowManifest } from "@workflow-engine/core";
import {
	generateKeypair,
	sealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptWorkflowSecrets } from "./decrypt-workflow.js";
import { createKeyStore, readyCrypto } from "./key-store.js";
import { verifyManifestSecrets } from "./verify-manifest.js";

// Rotation lifecycle without a K8s cluster: each phase represents the app
// starting with a different SECRETS_PRIVATE_KEYS CSV, exactly as the K8s
// Secret would deliver after `tofu apply` of the persistence project.
//
// The rotation contract lives entirely in the runtime's KeyStore +
// verifyManifestSecrets + decryptWorkflowSecrets. Exercising those three
// directly covers 8.5 with the same code paths the operator would hit
// post-merge via a live cluster apply.

beforeAll(async () => {
	await readyCrypto();
});

function freshKeypair(): { skB64: string; pk: Uint8Array } {
	const { publicKey, secretKey } = generateKeypair();
	return { skB64: Buffer.from(secretKey).toString("base64"), pk: publicKey };
}

function seal(pk: Uint8Array, plaintext: string): string {
	return Buffer.from(sealCiphertext(plaintext, pk)).toString("base64");
}

function workflow(
	name: string,
	secretsKeyId: string,
	ciphertextB64: string,
): WorkflowManifest {
	return {
		name,
		module: `${name}.js`,
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
		secrets: { MY_SECRET: ciphertextB64 },
		secretsKeyId,
	};
}

function manifestOf(workflows: WorkflowManifest[]): Manifest {
	return { workflows };
}

describe("secrets key rotation lifecycle", () => {
	it("retained old key decrypts; new primary seals fresh bundles; dropped key rejects", () => {
		// ── Phase 1 ─ CSV=[k1]. Seal a bundle against k1's public key;
		//    verify host-side verify + per-invocation decrypt both succeed.
		const k1 = freshKeypair();
		const store1 = createKeyStore(`k1:${k1.skB64}`);
		const k1Id = store1.getPrimary().keyId;
		const ctV1 = seal(k1.pk, "secret-v1");
		const wfV1 = workflow("wfV1", k1Id, ctV1);

		expect(verifyManifestSecrets(manifestOf([wfV1]), store1)).toBeNull();
		expect(decryptWorkflowSecrets(wfV1, store1)).toEqual({
			MY_SECRET: "secret-v1",
		});

		// ── Phase 2 ─ CSV=[k2, k1]. New primary = k2, k1 retained.
		//    (a) Old bundle still decrypts (k1's sk still in the store).
		//    (b) getPrimary() now returns k2 → public-key endpoint would
		//        serve k2's pk → CLI reseals fresh bundles against k2.
		//    (c) A fresh bundle sealed against k2 decrypts too.
		const k2 = freshKeypair();
		const store2 = createKeyStore(`k2:${k2.skB64},k1:${k1.skB64}`);
		const k2Id = store2.getPrimary().keyId;

		expect(k2Id).not.toBe(k1Id);
		expect(store2.lookup(k1Id)).toBeDefined();
		expect(store2.lookup(k2Id)).toBeDefined();

		// (a) pre-rotation bundle still decrypts via the retained sk1.
		expect(verifyManifestSecrets(manifestOf([wfV1]), store2)).toBeNull();
		expect(decryptWorkflowSecrets(wfV1, store2)).toEqual({
			MY_SECRET: "secret-v1",
		});

		// (b) CLI flow: fetch public-key endpoint → seal → upload.
		const endpointPrimary = store2.getPrimary();
		expect(endpointPrimary.keyId).toBe(k2Id);
		const ctV2 = seal(endpointPrimary.pk, "secret-v2");
		const wfV2 = workflow("wfV2", k2Id, ctV2);

		// (c) Fresh k2-sealed bundle verifies + decrypts.
		expect(verifyManifestSecrets(manifestOf([wfV2]), store2)).toBeNull();
		expect(decryptWorkflowSecrets(wfV2, store2)).toEqual({
			MY_SECRET: "secret-v2",
		});

		// Mixed manifest across keyIds is OK while both keys are present.
		expect(verifyManifestSecrets(manifestOf([wfV1, wfV2]), store2)).toBeNull();

		// ── Phase 3 ─ CSV=[k2]. k1 retired.
		//    Uploading a bundle still referencing keyId=k1 MUST be rejected
		//    as unknown_secret_key_id — the upload handler returns 400 on
		//    this structured failure.
		const store3 = createKeyStore(`k2:${k2.skB64}`);
		expect(store3.lookup(k1Id)).toBeUndefined();
		expect(store3.getPrimary().keyId).toBe(k2Id);

		const failure = verifyManifestSecrets(manifestOf([wfV1]), store3);
		expect(failure).toEqual({
			kind: "unknown_secret_key_id",
			workflow: "wfV1",
			keyId: k1Id,
		});

		// k2-sealed bundles continue to work against the post-rotation store.
		expect(verifyManifestSecrets(manifestOf([wfV2]), store3)).toBeNull();
		expect(decryptWorkflowSecrets(wfV2, store3)).toEqual({
			MY_SECRET: "secret-v2",
		});
	});
});
