import { constants } from "node:http2";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpTriggerContext } from "../context/index.js";

interface HttpTriggerDefinition {
	path: string;
	method: string;
	event: string;
	response: {
		status: ContentfulStatusCode;
		body: unknown;
	};
}

class HttpTriggerRegistry {
	readonly #triggers: HttpTriggerDefinition[] = [];

	register(definition: HttpTriggerDefinition): void {
		this.#triggers.push(definition);
	}

	lookup(path: string, method: string): HttpTriggerDefinition | null {
		return (
			this.#triggers.find((t) => t.path === path && t.method === method) ?? null
		);
	}
}

type TriggerContextFactory = (
	body: unknown,
	definition: HttpTriggerDefinition,
) => HttpTriggerContext;

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
}

const WEBHOOKS_PREFIX = "/webhooks/";

function httpTriggerMiddleware(
	registry: HttpTriggerRegistry,
	createContext: TriggerContextFactory,
): Middleware {
	return {
		match: `${WEBHOOKS_PREFIX}*`,
		handler: async (c: Context) => {
			const triggerPath = c.req.path.slice(WEBHOOKS_PREFIX.length);
			const definition = registry.lookup(triggerPath, c.req.method);

			if (!definition) {
				return c.notFound();
			}

			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json(
					{ error: "Invalid JSON body" },
					constants.HTTP_STATUS_BAD_REQUEST as ContentfulStatusCode,
				);
			}

			const ctx = createContext(body, definition);
			await ctx.emit(definition.event, body);

			return c.json(definition.response.body, definition.response.status);
		},
	};
}

export {
	type HttpTriggerDefinition,
	HttpTriggerRegistry,
	httpTriggerMiddleware,
	type Middleware,
	type TriggerContextFactory,
};
