import { describe, expect, it } from "vitest";
import {
	awaitCryptoReady,
	derivePublicKey,
	sealCiphertext,
	UnsealError,
	unsealCiphertext,
} from "./index.js";
// Tests use the binding to mint a fresh keypair; production callers are not
// permitted to import this file (file-private inside core/secrets/).
import { sodium } from "./sodium-binding.js";

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("secrets-crypto", () => {
	it("sealCiphertext + unsealCiphertext round-trip recovers the plaintext", async () => {
		await awaitCryptoReady();
		const { publicKey, privateKey } = sodium.crypto_box_keypair("uint8array");
		const ct = sealCiphertext("ghp_xxx", publicKey);
		const pt = unsealCiphertext(ct, publicKey, privateKey);
		expect(new TextDecoder().decode(pt)).toBe("ghp_xxx");
	});

	it("derivePublicKey reproduces the public half of the keypair", async () => {
		await awaitCryptoReady();
		const { publicKey, privateKey } = sodium.crypto_box_keypair("uint8array");
		const derived = derivePublicKey(privateKey);
		expect(toHex(derived)).toBe(toHex(publicKey));
	});

	it("unsealCiphertext throws UnsealError on garbage input", async () => {
		await awaitCryptoReady();
		const { publicKey, privateKey } = sodium.crypto_box_keypair("uint8array");
		const garbage = new Uint8Array(80).fill(0);
		expect(() => unsealCiphertext(garbage, publicKey, privateKey)).toThrow(
			UnsealError,
		);
	});

	it("awaitCryptoReady is idempotent across many calls", async () => {
		await Promise.all(Array.from({ length: 5 }, () => awaitCryptoReady()));
		// If we got here without hanging or throwing, the gate is idempotent.
		expect(true).toBe(true);
	});
});
