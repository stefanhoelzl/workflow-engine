import { constants } from "node:http2";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { EventSource } from "../event-source.js";
import { PayloadValidationError } from "../context/errors.js";

interface HttpTriggerDefinition {
	name: string;
	path: string;
	method?: string | undefined;
	response?:
		| {
				status?: number | undefined;
				body?: unknown;
		  }
		| undefined;
}

interface HttpTriggerResolved {
	name: string;
	path: string;
	method: string;
	response: {
		status: ContentfulStatusCode;
		body: unknown;
	};
}

const DEFAULT_METHOD = "POST";
const DEFAULT_RESPONSE_STATUS = 200 as ContentfulStatusCode;
const DEFAULT_RESPONSE_BODY = "";

class HttpTriggerRegistry {
	readonly #triggers: HttpTriggerResolved[] = [];

	register(definition: HttpTriggerDefinition): void {
		const method = definition.method ?? DEFAULT_METHOD;
		const existing = this.#triggers.findIndex(
			(t) => t.path === definition.path && t.method === method,
		);
		const resolved: HttpTriggerResolved = {
			name: definition.name,
			path: definition.path,
			method,
			response: {
				status: (definition.response?.status ??
					DEFAULT_RESPONSE_STATUS) as ContentfulStatusCode,
				body: definition.response?.body ?? DEFAULT_RESPONSE_BODY,
			},
		};
		if (existing === -1) {
			this.#triggers.push(resolved);
		} else {
			this.#triggers[existing] = resolved;
		}
	}

	get size(): number {
		return this.#triggers.length;
	}

	lookup(path: string, method: string): HttpTriggerResolved | null {
		return (
			this.#triggers.find((t) => t.path === path && t.method === method) ?? null
		);
	}
}

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
}

const WEBHOOKS_PREFIX = "/webhooks/";

function httpTriggerMiddleware(
	triggerSource: { readonly triggerRegistry: HttpTriggerRegistry },
	source: EventSource,
): Middleware {
	return {
		match: `${WEBHOOKS_PREFIX}*`,
		handler: async (c: Context) => {
			const triggerPath = c.req.path.slice(WEBHOOKS_PREFIX.length);

			if (triggerPath === "" && c.req.method === "GET") {
				const status =
					triggerSource.triggerRegistry.size > 0
						? constants.HTTP_STATUS_NO_CONTENT
						: constants.HTTP_STATUS_SERVICE_UNAVAILABLE;
				return c.body(null, status as ContentfulStatusCode);
			}

			const definition = triggerSource.triggerRegistry.lookup(
				triggerPath,
				c.req.method,
			);

			if (!definition) {
				return c.notFound();
			}

			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json(
					{ error: "Invalid JSON body" },
					constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode,
				);
			}

			const payload = {
				body,
				headers: Object.fromEntries(c.req.raw.headers),
				url: c.req.url,
				method: c.req.method,
			};

			try {
				await source.create(definition.name, payload, definition.name);
			} catch (error) {
				if (error instanceof PayloadValidationError) {
					return c.json(
						{
							error: "payload_validation_failed",
							event: error.eventType,
							issues: error.issues,
						},
						constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode,
					);
				}
				throw error;
			}

			return c.json(definition.response.body, definition.response.status);
		},
	};
}

export {
	type HttpTriggerDefinition,
	type HttpTriggerResolved,
	HttpTriggerRegistry,
	httpTriggerMiddleware,
	type Middleware,
};
