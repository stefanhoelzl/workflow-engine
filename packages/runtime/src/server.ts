import { Hono } from "hono";
import type { Middleware } from "./triggers/http.js";

function createServer(...middlewares: Middleware[]): Hono {
	const app = new Hono();

	for (const { match, handler } of middlewares) {
		app.use(match, handler);
	}

	return app;
}

export { createServer };
