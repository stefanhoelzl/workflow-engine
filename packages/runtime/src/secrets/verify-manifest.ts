import type { Manifest } from "@workflow-engine/core";
import {
	decryptSealed,
	type SecretsKeyStore,
	UnknownKeyIdError,
} from "./key-store.js";

interface UnknownKeyIdFailure {
	readonly kind: "unknown_secret_key_id";
	readonly workflow: string;
	readonly keyId: string;
}

interface SecretDecryptFailure {
	readonly kind: "secret_decrypt_failed";
	readonly workflow: string;
	readonly envName: string;
}

type SecretsVerifyFailure = UnknownKeyIdFailure | SecretDecryptFailure;

/**
 * Decrypt-verify every workflow.secrets entry. Runs host-side on upload
 * to fail fast when ciphertexts are corrupted or target an unknown keyId.
 * Plaintexts are discarded after verification (zero-cleared best-effort).
 *
 * Returns `null` on success, or a structured failure describing the
 * first failing workflow + envName (or unknown keyId).
 */
function verifyManifestSecrets(
	manifest: Manifest,
	keyStore: SecretsKeyStore,
): SecretsVerifyFailure | null {
	for (const workflow of manifest.workflows) {
		if (!workflow.secrets || workflow.secretsKeyId === undefined) {
			continue;
		}
		if (keyStore.lookup(workflow.secretsKeyId) === undefined) {
			return {
				kind: "unknown_secret_key_id",
				workflow: workflow.name,
				keyId: workflow.secretsKeyId,
			};
		}
		for (const [envName, ciphertext] of Object.entries(workflow.secrets)) {
			let plaintext: Uint8Array;
			try {
				plaintext = decryptSealed(ciphertext, workflow.secretsKeyId, keyStore);
			} catch (err) {
				if (err instanceof UnknownKeyIdError) {
					return {
						kind: "unknown_secret_key_id",
						workflow: workflow.name,
						keyId: err.keyId,
					};
				}
				return {
					kind: "secret_decrypt_failed",
					workflow: workflow.name,
					envName,
				};
			}
			// Best-effort wipe. Node/V8 may still hold the bytes elsewhere in
			// the heap; we don't rely on zeroing for security, but doing it
			// removes the only local reference the handler retains.
			plaintext.fill(0);
		}
	}
	return null;
}

export type { SecretsVerifyFailure };
export { verifyManifestSecrets };
