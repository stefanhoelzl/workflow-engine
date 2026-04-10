import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { githubAuthMiddleware } from "./auth.js";
import { createUploadHandler } from "./upload.js";

interface ApiOptions {
	registry: WorkflowRegistry;
	githubUser?: string | undefined;
}

function apiMiddleware(options: ApiOptions): Middleware[] {
	const middlewares: Middleware[] = [];

	if (options.githubUser) {
		middlewares.push({
			match: "/api/*",
			handler: githubAuthMiddleware({ githubUser: options.githubUser }),
		});
	}

	middlewares.push({
		match: "/api/workflows",
		handler: createUploadHandler(options.registry),
	});

	return middlewares;
}

export { apiMiddleware };
export type { ApiOptions };
