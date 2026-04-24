import { computeKeyId } from "@workflow-engine/core";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createKeyStore,
	decryptSealed,
	readySodium,
	SecretDecryptError,
	UnknownKeyIdError,
} from "./key-store.js";

beforeAll(async () => {
	await readySodium();
});

function makeCsv(
	entries: readonly { keyId: string; sk?: Uint8Array }[],
): string {
	return entries
		.map(({ keyId, sk }) => {
			const s = sk ?? sodium.randombytes_buf(32);
			return `${keyId}:${Buffer.from(s).toString("base64")}`;
		})
		.join(",");
}

describe("createKeyStore", () => {
	it("derives public keys for every entry and fingerprints as keyId", () => {
		const sk = sodium.randombytes_buf(32);
		const csv = makeCsv([{ keyId: "k1", sk }]);
		const store = createKeyStore(csv);
		const primary = store.getPrimary();
		// keyId is the sha256(pk)[:8] fingerprint, NOT the CSV label.
		expect(primary.keyId).toMatch(/^[0-9a-f]{16}$/);
		expect(primary.pk).toEqual(sodium.crypto_scalarmult_base(sk));
		expect(primary.sk).toEqual(sk);
	});

	it("preserves CSV order — first entry is primary", () => {
		const csv = makeCsv([{ keyId: "a" }, { keyId: "b" }, { keyId: "c" }]);
		const store = createKeyStore(csv);
		const ids = store.allKeyIds();
		expect(ids).toHaveLength(3);
		expect(store.getPrimary().keyId).toBe(ids[0]);
	});

	it("lookup returns undefined for unknown keyId", () => {
		const csv = makeCsv([{ keyId: "k1" }]);
		const store = createKeyStore(csv);
		expect(store.lookup("unknownfingerprint")).toBeUndefined();
	});

	it("lookup returns the resolved entry for known keyIds", () => {
		const csv = makeCsv([{ keyId: "k1" }, { keyId: "k2" }]);
		const store = createKeyStore(csv);
		const [firstId, secondId] = store.allKeyIds();
		expect(store.lookup(secondId ?? "")?.keyId).toBe(secondId);
		expect(store.lookup(firstId ?? "")?.keyId).toBe(firstId);
	});
});

describe("decryptSealed", () => {
	it("round-trips a crypto_box_seal ciphertext", () => {
		const sk = sodium.randombytes_buf(32);
		const pk = sodium.crypto_scalarmult_base(sk);
		const csv = makeCsv([{ keyId: "k1", sk }]);
		const store = createKeyStore(csv);
		const { keyId } = store.getPrimary();

		const plaintext = new TextEncoder().encode("hello world");
		const ct = sodium.crypto_box_seal(plaintext, pk);
		const b64 = Buffer.from(ct).toString("base64");

		const out = decryptSealed(b64, keyId, store);
		expect(new TextDecoder().decode(out)).toBe("hello world");
	});

	it("throws UnknownKeyIdError for an unknown keyId", () => {
		const store = createKeyStore(makeCsv([{ keyId: "k1" }]));
		expect(() => decryptSealed("AAAA", "nope", store)).toThrow(
			UnknownKeyIdError,
		);
	});

	it("throws SecretDecryptError for garbage ciphertext", () => {
		const store = createKeyStore(makeCsv([{ keyId: "k1" }]));
		const { keyId } = store.getPrimary();
		expect(() => decryptSealed("AAAA", keyId, store)).toThrow(
			SecretDecryptError,
		);
	});

	it("throws SecretDecryptError when sealed with a different public key", () => {
		const sk1 = sodium.randombytes_buf(32);
		const pk2 = sodium.crypto_scalarmult_base(sodium.randombytes_buf(32));

		const csv = makeCsv([{ keyId: "k1", sk: sk1 }]);
		const store = createKeyStore(csv);
		const { keyId } = store.getPrimary();

		const ct = sodium.crypto_box_seal(new TextEncoder().encode("x"), pk2);
		const b64 = Buffer.from(ct).toString("base64");

		expect(() => decryptSealed(b64, keyId, store)).toThrow(SecretDecryptError);
	});
});

// The runtime's synchronous `fingerprintSync` (Node `createHash`) and core's
// async `computeKeyId` (WebCrypto `subtle.digest`) must agree byte-for-byte:
// the CLI seals bundles using core's variant (imported from
// `@workflow-engine/core`), and the upload handler / runtime look them up
// using the runtime's variant. A silent divergence would cause every upload
// to 4xx with `unknown_secret_key_id`. The runtime's `fingerprintSync` is
// not exported, so we reach it through `keyStore.getPrimary().keyId`.
describe("keyId fingerprint agreement with core.computeKeyId", () => {
	it("matches for a freshly generated keypair", async () => {
		const kp = sodium.crypto_box_keypair();
		const store = createKeyStore(
			`a:${Buffer.from(kp.privateKey).toString("base64")}`,
		);
		expect(store.getPrimary().keyId).toBe(await computeKeyId(kp.publicKey));
	});

	it("matches across 5 independent keypairs", async () => {
		const pairs = Array.from({ length: 5 }, () => {
			const kp = sodium.crypto_box_keypair();
			const store = createKeyStore(
				`k:${Buffer.from(kp.privateKey).toString("base64")}`,
			);
			return { kp, store };
		});
		const asyncIds = await Promise.all(
			pairs.map(({ kp }) => computeKeyId(kp.publicKey)),
		);
		for (const [i, { store }] of pairs.entries()) {
			expect(store.getPrimary().keyId).toBe(asyncIds[i]);
		}
	});

	it("produces 16 lowercase hex chars (SECRETS_KEY_ID_BYTES=8)", async () => {
		const kp = sodium.crypto_box_keypair();
		expect(await computeKeyId(kp.publicKey)).toMatch(/^[0-9a-f]{16}$/);
	});
});
