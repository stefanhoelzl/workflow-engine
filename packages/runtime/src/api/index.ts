import { Hono } from "hono";
import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { githubAuthMiddleware } from "./auth.js";
import { createUploadHandler } from "./upload.js";

interface ApiOptions {
	registry: WorkflowRegistry;
	githubUser?: string | undefined;
}

function apiMiddleware(options: ApiOptions): Middleware {
	const app = new Hono().basePath("/api");

	if (options.githubUser) {
		app.use("/*", githubAuthMiddleware({ githubUser: options.githubUser }));
	}

	app.post("/workflows", createUploadHandler(options.registry));

	return {
		match: "/api/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { ApiOptions };
export { apiMiddleware };
