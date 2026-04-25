import { sodium } from "./sodium-binding.js";

function sealCiphertext(plaintext: string, publicKey: Uint8Array): Uint8Array {
	return sodium.crypto_box_seal(new TextEncoder().encode(plaintext), publicKey);
}

export { sealCiphertext };
