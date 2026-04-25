// Public surface of `@workflow-engine/core/secrets-crypto`.
//
// Owns the only libsodium-wrappers consumer in the monorepo. Public exports
// hide the backing crypto library so callers depend on capability names
// (`sealCiphertext`, `unsealCiphertext`, `awaitCryptoReady`,
// `derivePublicKey`, `generateKeypair`), not on `sodium.*`.
//
// MUST NOT be re-exported from `packages/core/src/index.ts` — the sandbox
// bundle resolves the main entry point and would otherwise pull libsodium.
//
// The implementation is inlined into this single file (rather than split
// across siblings + a barrel) because `core` is consumed both by the
// uncompiled-TS path (Vite/test runners) and by Node directly running the
// SDK's compiled `dist/cli/cli.js`. The latter follows `.js` import
// extensions literally, so subpath entries must be self-contained `.ts`
// files with no relative imports — matching the existing `./test-utils`
// pattern.

import sodium from "libsodium-wrappers";

let ready = false;

async function awaitCryptoReady(): Promise<void> {
	if (ready) {
		return;
	}
	await sodium.ready;
	ready = true;
}

interface Keypair {
	readonly publicKey: Uint8Array;
	readonly secretKey: Uint8Array;
}

function generateKeypair(): Keypair {
	const kp = sodium.crypto_box_keypair("uint8array");
	return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

function derivePublicKey(secretKey: Uint8Array): Uint8Array {
	return sodium.crypto_scalarmult_base(secretKey);
}

function sealCiphertext(plaintext: string, publicKey: Uint8Array): Uint8Array {
	return sodium.crypto_box_seal(new TextEncoder().encode(plaintext), publicKey);
}

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

export type { Keypair };
export {
	awaitCryptoReady,
	derivePublicKey,
	generateKeypair,
	sealCiphertext,
	UnsealError,
	unsealCiphertext,
};
