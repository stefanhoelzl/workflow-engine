import { sodium } from "./sodium-binding.js";

class UnsealError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsealError";
	}
}

function unsealCiphertext(
	ciphertext: Uint8Array,
	publicKey: Uint8Array,
	secretKey: Uint8Array,
): Uint8Array {
	try {
		return sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
	} catch (err) {
		throw new UnsealError(
			`sealed-box decryption failed${
				err instanceof Error ? `: ${err.message}` : ""
			}`,
		);
	}
}

export { UnsealError, unsealCiphertext };
