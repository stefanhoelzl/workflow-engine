import { constants } from "node:http2";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isMember, validateTenant } from "../auth/tenant.js";
import type { UserContext } from "../auth/user-context.js";
import type { Logger } from "../logger.js";
import {
	extractTenantTarGz,
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

const HTTP_NO_CONTENT =
	constants.HTTP_STATUS_NO_CONTENT as ContentfulStatusCode;
const HTTP_UNSUPPORTED_MEDIA_TYPE =
	constants.HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE as ContentfulStatusCode;
const HTTP_UNPROCESSABLE_ENTITY =
	constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode;
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
			const payload = result.issues
				? { error: result.error, issues: result.issues }
				: { error: result.error };
			return c.json(payload, HTTP_UNPROCESSABLE_ENTITY);
		}

		return c.body(null, HTTP_NO_CONTENT);
	};
}

export type { UploadDeps };
export { createUploadHandler };
