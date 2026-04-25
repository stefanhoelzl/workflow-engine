import { sodium } from "./sodium-binding.js";

function derivePublicKey(secretKey: Uint8Array): Uint8Array {
	return sodium.crypto_scalarmult_base(secretKey);
}

export { derivePublicKey };
