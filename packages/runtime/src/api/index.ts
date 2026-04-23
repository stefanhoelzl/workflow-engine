import { Hono } from "hono";
import type { ProviderRegistry } from "../auth/providers/index.js";
import { requireTenantMember } from "../auth/tenant-mw.js";
import type { Logger } from "../logger.js";
import { createNotFoundHandler } from "../services/content-negotiation.js";
import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { apiAuthMiddleware } from "./auth.js";
import { createUploadHandler } from "./upload.js";

// ---------------------------------------------------------------------------
// /api/* mount
// ---------------------------------------------------------------------------
//
// `/api/*` is the authenticated management plane. v1 exposes:
//   POST /api/workflows/:tenant — upload a workflow bundle (see upload.ts).
//
// SECURITY (CLAUDE.md + /SECURITY.md §4): `/api/*` dispatches by
// X-Auth-Provider; each registered provider resolves identity from the raw
// request. Session cookies are never read on this surface.

interface ApiOptions {
	registry: WorkflowRegistry;
	authRegistry: ProviderRegistry;
	logger: Logger;
}

function apiMiddleware(options: ApiOptions): Middleware {
	const app = new Hono().basePath("/api");

	app.use("/*", apiAuthMiddleware({ registry: options.authRegistry }));

	app.use("/workflows/:tenant", requireTenantMember());
	app.notFound(createNotFoundHandler());

	app.post(
		"/workflows/:tenant",
		createUploadHandler({ registry: options.registry, logger: options.logger }),
	);

	return {
		match: "/api/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { ApiOptions };
export { apiMiddleware };
