import { constants } from "node:http2";
import { ManifestSchema } from "@workflow-engine/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../logger.js";
import {
	type SecretsKeyStore,
	verifyManifestSecrets,
} from "../secrets/index.js";
import {
	extractOwnerTarGz,
	type RegisterResult,
	type WorkflowRegistry,
} from "../workflow-registry.js";

// ---------------------------------------------------------------------------
// POST /api/workflows/:owner/:repo — upload a repo's workflow bundle
// ---------------------------------------------------------------------------
//
// Payload: gzip-compressed tarball containing the root `manifest.json`
// (repo manifest with `workflows: [...]`) plus one `<name>.js` per workflow
// at the tarball root. The tarball is scoped to a single (owner, repo); the
// server stamps both from the URL path and persists under
// `workflows/<owner>/<repo>.tar.gz`.
//
// Auth: the /api/* surface is gated by `bearerUserMiddleware` +
// `authorizeMiddleware`; `requireOwnerMember()` is mounted on
// `/workflows/:owner/:repo` and enforces owner + repo regex validation +
// owner-`isMember` with a JSON 404 fail-closed response (see auth spec:
// "Owner-authorization middleware"). This handler never performs identifier
// checks inline.
//
// Error classification:
//   - 415: not a valid gzip/tar archive.
//   - 422: manifest validation failure (missing/malformed/schema-invalid),
//          missing workflow module, or unsupported trigger kind. Body
//          includes `{error, issues?}` as before.
//   - 400: user-config failure reported by at least one trigger backend
//          (`{ok: false}`). Body: `{error: "trigger_config_failed",
//          errors: TriggerConfigError[]}`. If infra errors also occurred,
//          includes `infra_errors: BackendInfraError[]`.
//   - 500: backend-infra failure (throw). Body:
//          `{error: "trigger_backend_failed", errors: BackendInfraError[]}`.

const HTTP_NO_CONTENT =
	constants.HTTP_STATUS_NO_CONTENT as ContentfulStatusCode;
const HTTP_UNSUPPORTED_MEDIA_TYPE =
	constants.HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE as ContentfulStatusCode;
const HTTP_UNPROCESSABLE_ENTITY =
	constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode;
const HTTP_BAD_REQUEST =
	constants.HTTP_STATUS_BAD_REQUEST as ContentfulStatusCode;
const HTTP_INTERNAL_ERROR =
	constants.HTTP_STATUS_INTERNAL_SERVER_ERROR as ContentfulStatusCode;

interface UploadDeps {
	readonly registry: WorkflowRegistry;
	readonly logger: Logger;
	readonly keyStore: SecretsKeyStore;
}

function failureResponse(
	c: Context,
	result: Extract<RegisterResult, { ok: false }>,
): Response {
	// Unresolved secret references (sentinels in trigger configs that point
	// at names absent from `manifest.secrets`) -> 400.
	if (result.secretFailures) {
		return c.json(
			{ error: result.error, failures: result.secretFailures },
			HTTP_BAD_REQUEST,
		);
	}
	// User-config errors from backend reconfigure -> 400.
	if (result.userErrors) {
		const body: Record<string, unknown> = {
			error: result.error,
			errors: result.userErrors,
		};
		if (result.infraErrors) {
			body.infra_errors = result.infraErrors;
		}
		return c.json(body, HTTP_BAD_REQUEST);
	}
	// Backend infra errors alone -> 500.
	if (result.infraErrors) {
		return c.json(
			{ error: result.error, errors: result.infraErrors },
			HTTP_INTERNAL_ERROR,
		);
	}
	// Manifest / archive-shape failures -> 422.
	const payload = result.issues
		? { error: result.error, issues: result.issues }
		: { error: result.error };
	return c.json(payload, HTTP_UNPROCESSABLE_ENTITY);
}

/**
 * Decrypt-verify any sealed workflow secrets before handing the bundle
 * to the registry. Parses manifest.json here (duplicating one pass of the
 * registry's manifest read) to keep crypto out of the registry module.
 * Returns a 400-ready error payload, or null if secrets pass or aren't
 * present. Errors unrelated to secrets (missing manifest.json, schema
 * violation) fall through — the registry re-reports them uniformly.
 */
function verifySecretsIfPresent(
	files: Map<string, string>,
	owner: string,
	keyStore: SecretsKeyStore,
): Record<string, unknown> | null {
	const manifestRaw = files.get("manifest.json");
	if (manifestRaw === undefined) {
		return null;
	}
	const parsed = ManifestSchema.safeParse(JSON.parse(manifestRaw));
	if (!parsed.success) {
		return null;
	}
	const failure = verifyManifestSecrets(parsed.data, keyStore);
	if (failure === null) {
		return null;
	}
	if (failure.kind === "unknown_secret_key_id") {
		return {
			error: "unknown_secret_key_id",
			owner,
			workflow: failure.workflow,
			keyId: failure.keyId,
		};
	}
	return {
		error: "secret_decrypt_failed",
		owner,
		workflow: failure.workflow,
		envName: failure.envName,
	};
}

function createUploadHandler(deps: UploadDeps) {
	return async (c: Context) => {
		const owner = c.req.param("owner") ?? "";
		const repo = c.req.param("repo") ?? "";

		const body = await c.req.arrayBuffer();
		const tarballBytes = new Uint8Array(body);
		let files: Map<string, string>;
		try {
			files = await extractOwnerTarGz(tarballBytes);
		} catch {
			return c.json(
				{ error: "Not a valid gzip/tar archive" },
				HTTP_UNSUPPORTED_MEDIA_TYPE,
			);
		}

		const secretsVerify = verifySecretsIfPresent(files, owner, deps.keyStore);
		if (secretsVerify !== null) {
			return c.json(secretsVerify, HTTP_BAD_REQUEST);
		}

		const result = await deps.registry.registerOwner(owner, repo, files, {
			tarballBytes,
		});
		if (!result.ok) {
			return failureResponse(c, result);
		}

		return c.body(null, HTTP_NO_CONTENT);
	};
}

export type { UploadDeps };
export { createUploadHandler };
