import { sodium } from "./sodium-binding.js";

let ready = false;

async function awaitCryptoReady(): Promise<void> {
	if (ready) {
		return;
	}
	await sodium.ready;
	ready = true;
}

export { awaitCryptoReady };
