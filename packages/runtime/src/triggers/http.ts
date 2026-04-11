import { constants } from "node:http2";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PayloadValidationError } from "../context/errors.js";
import type { EventSource } from "../event-source.js";

interface HttpTriggerDefinition {
	name: string;
	path: string;
	method: string;
	params?: string[] | undefined;
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

interface HttpTriggerMatch extends HttpTriggerResolved {
	params: Record<string, string>;
}

const DEFAULT_RESPONSE_STATUS = 200 as ContentfulStatusCode;
const DEFAULT_RESPONSE_BODY = "";

const PARAM_SEGMENT_RE = /[:*]/;

function toUrlPatternPath(path: string): string {
	return path.replace(/\*(\w+)/g, ":$1+");
}

interface RegisteredTrigger {
	resolved: HttpTriggerResolved;
	pattern: URLPattern;
	isStatic: boolean;
}

class HttpTriggerRegistry {
	readonly #triggers: RegisteredTrigger[] = [];

	register(definition: HttpTriggerDefinition): void {
		const method = definition.method;
		const existing = this.#triggers.findIndex(
			(t) =>
				t.resolved.path === definition.path && t.resolved.method === method,
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
		const entry: RegisteredTrigger = {
			resolved,
			pattern: new URLPattern({
				pathname: `/${toUrlPatternPath(definition.path)}`,
			}),
			isStatic: !PARAM_SEGMENT_RE.test(definition.path),
		};
		if (existing === -1) {
			this.#triggers.push(entry);
		} else {
			this.#triggers[existing] = entry;
		}
	}

	get size(): number {
		return this.#triggers.length;
	}

	lookup(path: string, method: string): HttpTriggerMatch | null {
		const pathname = `/${path}`;
		// Static triggers take priority over parameterized
		return (
			this.#matchTrigger(pathname, method, true) ??
			this.#matchTrigger(pathname, method, false)
		);
	}

	#matchTrigger(
		pathname: string,
		method: string,
		isStatic: boolean,
	): HttpTriggerMatch | null {
		for (const trigger of this.#triggers) {
			if (trigger.isStatic !== isStatic) {
				continue;
			}
			if (trigger.resolved.method !== method) {
				continue;
			}
			const result = trigger.pattern.exec({ pathname });
			if (!result) {
				continue;
			}
			const groups = result.pathname.groups as Record<string, string>;
			const params: Record<string, string> = {};
			for (const [key, value] of Object.entries(groups)) {
				if (value !== undefined) {
					params[key] = value;
				}
			}
			return { ...trigger.resolved, params };
		}
		return null;
	}
}

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
}

const WEBHOOKS_PREFIX = "/webhooks/";

function extractQueryParams(url: string): Record<string, string[]> {
	const parsed = new URL(url);
	const query: Record<string, string[]> = {};
	for (const key of parsed.searchParams.keys()) {
		query[key] = parsed.searchParams.getAll(key);
	}
	return query;
}

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
				params: definition.params,
				query: extractQueryParams(c.req.url),
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
	type HttpTriggerMatch,
	HttpTriggerRegistry,
	type HttpTriggerResolved,
	httpTriggerMiddleware,
	type Middleware,
};
