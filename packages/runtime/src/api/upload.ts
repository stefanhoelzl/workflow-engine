import { constants } from "node:http2";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isMember, validateTenant } from "../auth/tenant.js";
import type { UserContext } from "../auth/user-context.js";
import type { Logger } from "../logger.js";
import {
	extractTenantTarGz,
	type RegisterResult,
	type WorkflowRegistry,
} from "../workflow-registry.js";

// ---------------------------------------------------------------------------
// POST /api/workflows/:tenant — upload a tenant bundle
// ---------------------------------------------------------------------------
//
// Payload: gzip-compressed tarball containing the root `manifest.json`
// (tenant manifest with `workflows: [...]`) plus one `<name>.js` per
// workflow at the tarball root.
//
// Auth: `githubAuthMiddleware` gates the /api/* surface; `userMiddleware`
// populates `UserContext` (orgs + name). The handler performs a tenant
// membership check — non-members (and invalid tenant strings) receive
// 404 Not Found, indistinguishable from "tenant does not exist."
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
const HTTP_NOT_FOUND = constants.HTTP_STATUS_NOT_FOUND as ContentfulStatusCode;

interface UploadDeps {
	readonly registry: WorkflowRegistry;
	readonly logger: Logger;
}

function notFound(c: Context): Response {
	return c.json({ error: "Not Found" }, HTTP_NOT_FOUND);
}

function checkTenantAccess(c: Context, tenant: string): Response | undefined {
	if (c.get("authOpen")) {
		return;
	}
	const user = c.get("user") as UserContext | undefined;
	if (user && isMember(user, tenant)) {
		return;
	}
	return notFound(c);
}

function failureResponse(
	c: Context,
	result: Extract<RegisterResult, { ok: false }>,
): Response {
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

function createUploadHandler(deps: UploadDeps) {
	return async (c: Context) => {
		const tenant = c.req.param("tenant") ?? "";
		if (!validateTenant(tenant)) {
			return notFound(c);
		}

		const accessDenied = checkTenantAccess(c, tenant);
		if (accessDenied) {
			return accessDenied;
		}

		const body = await c.req.arrayBuffer();
		const tarballBytes = new Uint8Array(body);
		let files: Map<string, string>;
		try {
			files = await extractTenantTarGz(tarballBytes);
		} catch {
			return c.json(
				{ error: "Not a valid gzip/tar archive" },
				HTTP_UNSUPPORTED_MEDIA_TYPE,
			);
		}

		const result = await deps.registry.registerTenant(tenant, files, {
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
