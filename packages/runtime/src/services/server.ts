import { constants } from "node:http2";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../logger.js";
import type { Middleware } from "../triggers/http.js";
import {
	createErrorHandler,
	createNotFoundHandler,
	type Pages,
} from "./content-negotiation.js";
import type { Service } from "./index.js";

const BODY_LIMIT_BYTES = 10_485_760;
const HTTP_FOUND_STATUS = 302;
const HTTP_PAYLOAD_TOO_LARGE =
	constants.HTTP_STATUS_PAYLOAD_TOO_LARGE as ContentfulStatusCode;
const HTTP_FOUND = constants.HTTP_STATUS_FOUND as typeof HTTP_FOUND_STATUS;

interface AppOptions {
	pages?: Pages;
	logger?: Logger;
}

function createApp(opts: AppOptions = {}, ...middlewares: Middleware[]): Hono {
	const app = new Hono();

	app.use(
		"*",
		bodyLimit({
			maxSize: BODY_LIMIT_BYTES,
			onError: (c) =>
				c.json({ error: "payload_too_large" }, HTTP_PAYLOAD_TOO_LARGE),
		}),
	);

	app.get("/", (c) => c.redirect("/trigger", HTTP_FOUND));

	for (const { match, handler } of middlewares) {
		app.use(match, handler);
		if (match.endsWith("/*")) {
			app.use(match.slice(0, -2), handler);
		}
	}

	app.notFound(createNotFoundHandler(opts.pages));
	app.onError(
		createErrorHandler({
			...(opts.pages ? { pages: opts.pages } : {}),
			...(opts.logger ? { logger: opts.logger } : {}),
		}),
	);

	return app;
}

function createServer(
	port: number,
	opts: AppOptions,
	...middlewares: Middleware[]
): Service {
	const app = createApp(opts, ...middlewares);
	let server: ServerType | null = null;

	return {
		start(): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				server = serve({ fetch: app.fetch, port });
				server.on("error", reject);
				server.on("listening", () => {
					server?.removeListener("error", reject);
					opts.logger?.info(`Runtime listening on port ${port}`);
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

export type { AppOptions };
export { createApp, createServer };
