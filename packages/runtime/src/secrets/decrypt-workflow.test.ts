import {
	derivePublicKey,
	generateKeypair,
	sealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeWorkflowManifest as makeWorkflow } from "../test-utils/manifest.js";
import { decryptWorkflowSecrets } from "./decrypt-workflow.js";
import { createKeyStore, readyCrypto, UnknownKeyIdError } from "./key-store.js";

beforeAll(async () => {
	await readyCrypto();
});

describe("decryptWorkflowSecrets", () => {
	it("returns {} when manifest has no secrets", () => {
		const store = createKeyStore(
			`k1:${Buffer.from(generateKeypair().secretKey).toString("base64")}`,
		);
		expect(decryptWorkflowSecrets(makeWorkflow(), store)).toEqual({});
	});

	it("decrypts every ciphertext into a plaintextStore", () => {
		const sk = generateKeypair().secretKey;
		const pk = derivePublicKey(sk);
		const store = createKeyStore(`k1:${Buffer.from(sk).toString("base64")}`);
		const primary = store.getPrimary();
		const sealA = sealCiphertext("aaa", pk);
		const sealB = sealCiphertext("bbb", pk);
		const out = decryptWorkflowSecrets(
			makeWorkflow({
				secrets: {
					A: Buffer.from(sealA).toString("base64"),
					B: Buffer.from(sealB).toString("base64"),
				},
				secretsKeyId: primary.keyId,
			}),
			store,
		);
		expect(out).toEqual({ A: "aaa", B: "bbb" });
	});

	it("throws UnknownKeyIdError for unknown keyId", () => {
		const store = createKeyStore(
			`k1:${Buffer.from(generateKeypair().secretKey).toString("base64")}`,
		);
		expect(() =>
			decryptWorkflowSecrets(
				makeWorkflow({
					secrets: { A: "AAAA" },
					secretsKeyId: "ffffffffffffffff",
				}),
				store,
			),
		).toThrow(UnknownKeyIdError);
	});
});
