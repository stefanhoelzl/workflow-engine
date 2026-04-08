import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { Middleware } from "../triggers/http.js";
import type { Service } from "./index.js";

function createApp(...middlewares: Middleware[]): Hono {
	const app = new Hono();

	for (const { match, handler } of middlewares) {
		app.use(match, handler);
	}

	return app;
}

function createServer(port: number, ...middlewares: Middleware[]): Service {
	const app = createApp(...middlewares);
	let server: ServerType | null = null;

	return {
		start(): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				server = serve({ fetch: app.fetch, port });
				server.on("error", reject);
				server.on("listening", () => {
					server?.removeListener("error", reject);
				});
				server.on("close", resolve);
			});
		},
		stop(): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				if (!server) {
					resolve();
					return;
				}
				server.close((err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		},
	};
}

export { createApp, createServer };
