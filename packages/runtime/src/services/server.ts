import { constants } from "node:http2";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Middleware } from "../triggers/http.js";
import type { Service } from "./index.js";

const BODY_LIMIT_BYTES = 10_485_760;
const HTTP_PAYLOAD_TOO_LARGE =
	constants.HTTP_STATUS_PAYLOAD_TOO_LARGE as ContentfulStatusCode;

function createApp(...middlewares: Middleware[]): Hono {
	const app = new Hono();

	app.use(
		"*",
		bodyLimit({
			maxSize: BODY_LIMIT_BYTES,
			onError: (c) =>
				c.json({ error: "payload_too_large" }, HTTP_PAYLOAD_TOO_LARGE),
		}),
	);

	for (const { match, handler } of middlewares) {
		app.use(match, handler);
		if (match.endsWith("/*")) {
			app.use(match.slice(0, -2), handler);
		}
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
