import { createHash } from "node:crypto";
import { SECRETS_KEY_ID_BYTES } from "@workflow-engine/core";
import sodium from "libsodium-wrappers";
import { parseSecretsPrivateKeys } from "./parse-keys.js";

interface ResolvedKey {
	readonly keyId: string;
	readonly pk: Uint8Array;
	readonly sk: Uint8Array;
}

interface SecretsKeyStore {
	getPrimary(): ResolvedKey;
	lookup(keyId: string): ResolvedKey | undefined;
	allKeyIds(): readonly string[];
}

class UnknownKeyIdError extends Error {
	readonly keyId: string;
	constructor(keyId: string) {
		// keyId is a public fingerprint (first 8 bytes of sha256(public key));
		// including it in `.message` is safe and operator-useful for
		// diagnosing "bundle sealed against a retired key".
		super(`unknown secretsKeyId "${keyId}"`);
		// biome-ignore lint/security/noSecrets: false-positive entropy detection on the error class name; no secret material present
		this.name = "UnknownKeyIdError";
		this.keyId = keyId;
	}
}

class SecretDecryptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretDecryptError";
	}
}

let sodiumReady = false;

/**
 * Ensures libsodium's WASM has initialised before any crypto primitive is
 * called. Callers MUST await this before invoking `createKeyStore` /
 * `decryptSealed`. The runtime's bootstrap does so once at startup; tests
 * use the same helper.
 */
async function readySodium(): Promise<void> {
	if (!sodiumReady) {
		await sodium.ready;
		sodiumReady = true;
	}
}

function derivePublic(sk: Uint8Array): Uint8Array {
	return sodium.crypto_scalarmult_base(sk);
}

// Computes the canonical keyId fingerprint for a public key, matching the
// protocol-level `computeKeyId` in `@workflow-engine/core` (async, WebCrypto).
// This is the synchronous Node variant used inside the key-store.
function fingerprintSync(publicKey: Uint8Array): string {
	return createHash("sha256")
		.update(publicKey)
		.digest("hex")
		.slice(0, SECRETS_KEY_ID_BYTES * 2);
}

/**
 * Builds an in-memory store of X25519 keys from a parsed CSV. Public keys
 * are derived from each secret key once at construction — the runtime
 * never stores them separately.
 *
 * The CSV's per-entry labels (e.g. `"k1"`) are operator-facing bookkeeping
 * and NOT used as lookup keys at runtime. The store maps entries by their
 * canonical fingerprint (`sha256(pk).slice(0, SECRETS_KEY_ID_BYTES * 2)`
 * hex — the same value `computeKeyId` produces in `@workflow-engine/core`).
 * The manifest's `secretsKeyId` and the public-key endpoint's `keyId`
 * both use that fingerprint; `lookup(keyId)` takes the fingerprint too.
 *
 * Callers MUST `await readySodium()` before invoking this function.
 */
function createKeyStore(csv: string): SecretsKeyStore {
	if (!sodiumReady) {
		throw new Error(
			"createKeyStore: libsodium not initialised; call readySodium() first",
		);
	}
	const parsed = parseSecretsPrivateKeys(csv);
	const resolved = new Map<string, ResolvedKey>();
	const order: string[] = [];
	for (const { sk } of parsed) {
		const pk = derivePublic(sk);
		const keyId = fingerprintSync(pk);
		if (resolved.has(keyId)) {
			throw new Error(
				`createKeyStore: duplicate fingerprint "${keyId}" (two CSV entries derive to the same public key)`,
			);
		}
		resolved.set(keyId, { keyId, pk, sk });
		order.push(keyId);
	}
	const primaryId: string | undefined = order[0];
	if (primaryId === undefined) {
		throw new Error("createKeyStore: parsed key list was empty");
	}
	const primaryKeyId: string = primaryId;

	function getPrimary(): ResolvedKey {
		const key = resolved.get(primaryKeyId);
		if (key === undefined) {
			throw new Error(
				"createKeyStore: primary key missing (should not happen)",
			);
		}
		return key;
	}

	return {
		getPrimary,
		lookup(keyId: string): ResolvedKey | undefined {
			return resolved.get(keyId);
		},
		allKeyIds(): readonly string[] {
			return order;
		},
	};
}

/**
 * Decrypts a base64-encoded `crypto_box_seal` ciphertext using the keypair
 * identified by `keyId`. Throws `UnknownKeyIdError` if the keyId is not in
 * the store, or `SecretDecryptError` if the underlying seal-open fails.
 *
 * Callers MUST `await readySodium()` before invoking.
 */
function decryptSealed(
	b64Ciphertext: string,
	keyId: string,
	store: SecretsKeyStore,
): Uint8Array {
	const entry = store.lookup(keyId);
	if (entry === undefined) {
		throw new UnknownKeyIdError(keyId);
	}
	let ct: Uint8Array;
	try {
		ct = Uint8Array.from(Buffer.from(b64Ciphertext, "base64"));
	} catch (err) {
		throw new SecretDecryptError(
			`ciphertext base64 decode failed${
				err instanceof Error ? `: ${err.message}` : ""
			}`,
		);
	}
	try {
		return sodium.crypto_box_seal_open(ct, entry.pk, entry.sk);
	} catch (err) {
		throw new SecretDecryptError(
			`crypto_box_seal_open failed${
				err instanceof Error ? `: ${err.message}` : ""
			}`,
		);
	}
}

export type { ResolvedKey, SecretsKeyStore };
export {
	createKeyStore,
	decryptSealed,
	readySodium,
	SecretDecryptError,
	UnknownKeyIdError,
};
