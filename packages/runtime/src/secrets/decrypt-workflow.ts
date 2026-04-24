import type { WorkflowManifest } from "@workflow-engine/core";
import { decryptSealed, type SecretsKeyStore } from "./key-store.js";

/**
 * Decrypts every entry in `workflow.secrets` into a `plaintextStore`
 * keyed by envName. Returns `{}` when the workflow declares no secrets.
 *
 * Called once per sandbox construction (see sandbox-store). Errors
 * (unknown keyId, decryption failure) propagate so the sandbox build
 * fails fast — the alternative would be runtime failures on every
 * invocation.
 */
function decryptWorkflowSecrets(
	workflow: WorkflowManifest,
	keyStore: SecretsKeyStore,
): Record<string, string> {
	if (!workflow.secrets || workflow.secretsKeyId === undefined) {
		return {};
	}
	const out: Record<string, string> = {};
	for (const [envName, ciphertext] of Object.entries(workflow.secrets)) {
		const bytes = decryptSealed(ciphertext, workflow.secretsKeyId, keyStore);
		out[envName] = new TextDecoder().decode(bytes);
		bytes.fill(0);
	}
	return out;
}

export { decryptWorkflowSecrets };
