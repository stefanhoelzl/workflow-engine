import { Hono } from "hono";
import type { GitHubAuth } from "../config.js";
import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { githubAuthMiddleware, rejectAllMiddleware } from "./auth.js";
import { createUploadHandler } from "./upload.js";

interface ApiOptions {
	registry: WorkflowRegistry;
	githubAuth: GitHubAuth;
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

	app.post("/workflows", createUploadHandler(options.registry));

	return {
		match: "/api/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { ApiOptions };
export { apiMiddleware };
