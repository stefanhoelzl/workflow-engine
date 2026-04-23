import { Hono } from "hono";
import type { Auth } from "../auth/allowlist.js";
import { bearerUserMiddleware } from "../auth/bearer-user.js";
import { requireTenantMember } from "../auth/tenant-mw.js";
import type { Logger } from "../logger.js";
import { createNotFoundHandler } from "../services/content-negotiation.js";
import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { authorizeMiddleware, rejectAllMiddleware } from "./auth.js";
import { createUploadHandler } from "./upload.js";

// ---------------------------------------------------------------------------
// /api/* mount
// ---------------------------------------------------------------------------
//
// The `/api/*` surface is the authenticated management plane. v1 exposes
// one route here:
//   POST /api/workflows — upload a workflow bundle (see upload.ts).
//
// SECURITY (CLAUDE.md + /SECURITY.md §4): `/api/*` is Bearer-only. Session
// cookies are never read on this surface; the `authorizeMiddleware` gate
// consumes `UserContext` populated by `bearerUserMiddleware`, which reads
// only the `Authorization` header.

interface ApiOptions {
	registry: WorkflowRegistry;
	auth: Auth;
	logger: Logger;
	// Test seam: overrides the `fetch` used by `bearerUserMiddleware` (user
	// resolution).
	fetchFn?: typeof globalThis.fetch;
}

function apiMiddleware(options: ApiOptions): Middleware {
	const app = new Hono().basePath("/api");

	switch (options.auth.mode) {
		case "restricted":
			app.use(
				"/*",
				bearerUserMiddleware(
					options.fetchFn ? { fetchFn: options.fetchFn } : {},
				),
			);
			app.use("/*", authorizeMiddleware({ auth: options.auth }));
			break;
		case "disabled":
			app.use("/*", rejectAllMiddleware());
			break;
		case "open":
			// Open mode is dev-only (explicit __DISABLE_AUTH__ sentinel); skip the
			// tenant-membership check in handlers. The `authOpen` flag signals
			// downstream handlers that they must not treat `user` absence as
			// fail-closed.
			app.use("/*", async (c, next) => {
				c.set("authOpen", true);
				await next();
			});
			break;
		default: {
			const exhaustive: never = options.auth;
			throw new Error(`unreachable: ${JSON.stringify(exhaustive)}`);
		}
	}

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
