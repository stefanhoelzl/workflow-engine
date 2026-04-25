import { sodium } from "./sodium-binding.js";

interface Keypair {
	readonly publicKey: Uint8Array;
	readonly secretKey: Uint8Array;
}

function generateKeypair(): Keypair {
	const kp = sodium.crypto_box_keypair("uint8array");
	return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export type { Keypair };
export { generateKeypair };
