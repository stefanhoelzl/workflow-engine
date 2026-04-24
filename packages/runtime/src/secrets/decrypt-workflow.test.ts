import type { WorkflowManifest } from "@workflow-engine/core";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptWorkflowSecrets } from "./decrypt-workflow.js";
import { createKeyStore, readySodium, UnknownKeyIdError } from "./key-store.js";

beforeAll(async () => {
	await readySodium();
});

function makeWorkflow(
	overrides: Partial<WorkflowManifest> = {},
): WorkflowManifest {
	return {
		name: "wf",
		module: "wf.js",
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
		...overrides,
	};
}

describe("decryptWorkflowSecrets", () => {
	it("returns {} when manifest has no secrets", () => {
		const store = createKeyStore(
			`k1:${Buffer.from(sodium.randombytes_buf(32)).toString("base64")}`,
		);
		expect(decryptWorkflowSecrets(makeWorkflow(), store)).toEqual({});
	});

	it("decrypts every ciphertext into a plaintextStore", () => {
		const sk = sodium.randombytes_buf(32);
		const pk = sodium.crypto_scalarmult_base(sk);
		const store = createKeyStore(`k1:${Buffer.from(sk).toString("base64")}`);
		const primary = store.getPrimary();
		const sealA = sodium.crypto_box_seal(new TextEncoder().encode("aaa"), pk);
		const sealB = sodium.crypto_box_seal(new TextEncoder().encode("bbb"), pk);
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
			`k1:${Buffer.from(sodium.randombytes_buf(32)).toString("base64")}`,
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
