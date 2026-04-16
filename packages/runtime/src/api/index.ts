import { Hono } from "hono";
import type { GitHubAuth } from "../config.js";
import type { Logger } from "../logger.js";
import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { githubAuthMiddleware, rejectAllMiddleware } from "./auth.js";
import { createUploadHandler } from "./upload.js";

// ---------------------------------------------------------------------------
// /api/* mount
// ---------------------------------------------------------------------------
//
// The `/api/*` surface is the authenticated management plane. v1 exposes
// one route here:
//   POST /api/workflows — upload a workflow bundle (see upload.ts).
//
// SECURITY (CLAUDE.md + /SECURITY.md §4): this middleware is the only
// place `githubAuthMiddleware` attaches to `/api/*`. Any future `/api/*`
// route added elsewhere MUST go through this middleware — do NOT add a
// second mount point.

interface ApiOptions {
	registry: WorkflowRegistry;
	githubAuth: GitHubAuth;
	logger: Logger;
}

function apiMiddleware(options: ApiOptions): Middleware {
	const app = new Hono().basePath("/api");

	switch (options.githubAuth.mode) {
		case "restricted":
			app.use(
				"/*",
				githubAuthMiddleware({ githubUsers: options.githubAuth.users }),
			);
			break;
		case "disabled":
			app.use("/*", rejectAllMiddleware());
			break;
		case "open":
			break;
		default: {
			const exhaustive: never = options.githubAuth;
			throw new Error(`unreachable: ${JSON.stringify(exhaustive)}`);
		}
	}

	app.post(
		"/workflows",
		createUploadHandler({ registry: options.registry, logger: options.logger }),
	);

	return {
		match: "/api/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { ApiOptions };
export { apiMiddleware };
