import { computeKeyId } from "@workflow-engine/core";
import type { Context } from "hono";
import type { SecretsKeyStore } from "../secrets/index.js";

interface PublicKeyHandlerOptions {
	readonly keyStore: SecretsKeyStore;
}

/**
 * GET /api/workflows/:tenant/public-key
 *
 * Returns the current primary X25519 public key and its fingerprint so
 * that the `wfe upload` CLI can seal workflow secrets before POSTing the
 * bundle. Authentication + tenant-membership are enforced by the parent
 * `/api/workflows/:tenant` middleware stack (bearer user -> tenant member);
 * unknown tenants and non-members fall through to the default 404.
 *
 * The returned `keyId` is computed via `computeKeyId(publicKey)` from
 * `@workflow-engine/core` so all callers (CLI, upload handler, this route)
 * agree on the fingerprint. Public keys are public by definition — the
 * endpoint exposes no secret material.
 */
function createPublicKeyHandler(
	options: PublicKeyHandlerOptions,
): (c: Context) => Promise<Response> {
	return async (c) => {
		const primary = options.keyStore.getPrimary();
		const publicKeyB64 = Buffer.from(primary.pk).toString("base64");
		const keyId = await computeKeyId(primary.pk);
		return c.json({
			algorithm: "x25519" as const,
			publicKey: publicKeyB64,
			keyId,
		});
	};
}

export type { PublicKeyHandlerOptions };
export { createPublicKeyHandler };
