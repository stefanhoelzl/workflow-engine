import { constants } from "node:http2";
import type { HttpTriggerResult } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Executor } from "../executor/index.js";
import type { LookupResult, WorkflowRegistry } from "../workflow-registry.js";

// ---------------------------------------------------------------------------
// HTTP trigger middleware (v1, executor-backed)
// ---------------------------------------------------------------------------
//
// The registry owns the routing index. The middleware:
//   1. Handles GET /webhooks/ health probe (204 if any trigger registered,
//      503 otherwise).
//   2. Parses /webhooks/<tenant>/<workflow>/<trigger-path> into components.
//   3. Calls `registry.lookup(tenant, workflow, triggerPath, method)`; 404
//      if no match.
//   4. Parses JSON body; 422 on parse failure.
//   5. Validates payload via the match's `validator`; 422 on failure.
//   6. Calls `executor.invoke(tenant, workflow, triggerName, payload,
//      bundleSource)` and serializes the HttpTriggerResult response.

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
}

// ---------------------------------------------------------------------------
// Payload validator (JSON Schema -> validator function)
// ---------------------------------------------------------------------------

interface ValidationIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

interface ValidatorResult<T> {
	readonly ok: boolean;
	readonly value?: T;
	readonly issues?: ValidationIssue[];
}

interface PayloadValidator {
	validateBody(value: unknown): ValidatorResult<unknown>;
	validateQuery(value: unknown): ValidatorResult<unknown>;
	validateParams(value: unknown): ValidatorResult<unknown>;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const WEBHOOKS_PREFIX = "/webhooks/";
const HTTP_NO_CONTENT =
	constants.HTTP_STATUS_NO_CONTENT as ContentfulStatusCode;
const HTTP_SERVICE_UNAVAILABLE =
	constants.HTTP_STATUS_SERVICE_UNAVAILABLE as ContentfulStatusCode;
const HTTP_UNPROCESSABLE_ENTITY =
	constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode;

function extractQueryParams(url: string): Record<string, string[]> {
	const parsed = new URL(url);
	const query: Record<string, string[]> = {};
	for (const key of parsed.searchParams.keys()) {
		query[key] = parsed.searchParams.getAll(key);
	}
	return query;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((v, k) => {
		out[k] = v;
	});
	return out;
}

function validationFailure(
	c: Context,
	issues: ValidationIssue[] | undefined,
): Response {
	return c.json(
		{
			error: "payload_validation_failed",
			issues: issues ?? [],
		},
		HTTP_UNPROCESSABLE_ENTITY,
	);
}

const DEFAULT_HTTP_STATUS = 200;

function serializeHttpResult(c: Context, result: HttpTriggerResult): Response {
	const status = (result.status ?? DEFAULT_HTTP_STATUS) as ContentfulStatusCode;
	const body = result.body ?? "";
	const headers: Record<string, string> = { ...(result.headers ?? {}) };
	if (typeof body === "string") {
		return c.body(body, status, headers);
	}
	if (body === null || body === undefined) {
		return c.body("", status, headers);
	}
	return c.json(body, status, headers);
}

async function parseBody(
	c: Context,
): Promise<
	{ ok: true; value: unknown } | { ok: false; issues: ValidationIssue[] }
> {
	try {
		const value = await c.req.json();
		return { ok: true, value };
	} catch {
		return {
			ok: false,
			issues: [{ path: ["body"], message: "Invalid JSON body" }],
		};
	}
}

function runValidators(
	match: LookupResult,
	body: unknown,
	rawQuery: Record<string, string[]>,
):
	| { ok: true; body: unknown; query: unknown; params: unknown }
	| { ok: false; issues: ValidationIssue[] | undefined } {
	const bodyResult = match.validator.validateBody(body);
	if (!bodyResult.ok) {
		return { ok: false, issues: bodyResult.issues };
	}
	const queryResult = match.validator.validateQuery(rawQuery);
	if (!queryResult.ok) {
		return { ok: false, issues: queryResult.issues };
	}
	const paramsResult = match.validator.validateParams(match.params);
	if (!paramsResult.ok) {
		return { ok: false, issues: paramsResult.issues };
	}
	return {
		ok: true,
		body: bodyResult.value,
		query: queryResult.value ?? rawQuery,
		params: paramsResult.value ?? match.params,
	};
}

async function handleTriggerRequest(
	c: Context,
	tenant: string,
	match: LookupResult,
	executor: Executor,
): Promise<Response> {
	const bodyParse = await parseBody(c);
	if (!bodyParse.ok) {
		return validationFailure(c, bodyParse.issues);
	}
	const rawQuery = extractQueryParams(c.req.url);
	const validated = runValidators(match, bodyParse.value, rawQuery);
	if (!validated.ok) {
		return validationFailure(c, validated.issues);
	}
	const payload = {
		body: validated.body,
		headers: headersToRecord(c.req.raw.headers),
		url: c.req.url,
		method: c.req.method,
		params: validated.params,
		query: validated.query,
	};
	const result = await executor.invoke(
		tenant,
		match.workflow,
		match.triggerName,
		payload,
		match.bundleSource,
	);
	return serializeHttpResult(c, result);
}

const TENANT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

function httpTriggerMiddleware(
	registry: WorkflowRegistry,
	executor: Executor,
): Middleware {
	return {
		match: `${WEBHOOKS_PREFIX}*`,
		handler: (c: Context) => {
			const afterPrefix = c.req.path.slice(WEBHOOKS_PREFIX.length);

			if (afterPrefix === "" && c.req.method === "GET") {
				const status =
					registry.size > 0 ? HTTP_NO_CONTENT : HTTP_SERVICE_UNAVAILABLE;
				return Promise.resolve(c.body(null, status));
			}

			// Parse /webhooks/<tenant>/<workflow-name>/<trigger-path>
			const slashOne = afterPrefix.indexOf("/");
			if (slashOne <= 0) {
				return Promise.resolve(c.notFound());
			}
			const tenant = afterPrefix.slice(0, slashOne);
			const rest = afterPrefix.slice(slashOne + 1);
			const slashTwo = rest.indexOf("/");
			if (slashTwo <= 0) {
				return Promise.resolve(c.notFound());
			}
			const workflowName = rest.slice(0, slashTwo);
			const triggerPath = rest.slice(slashTwo + 1);
			if (!(TENANT_NAME_RE.test(tenant) && TENANT_NAME_RE.test(workflowName))) {
				return Promise.resolve(c.notFound());
			}

			const match = registry.lookup(
				tenant,
				workflowName,
				triggerPath,
				c.req.method,
			);
			if (!match) {
				return Promise.resolve(c.notFound());
			}
			return handleTriggerRequest(c, tenant, match, executor);
		},
	};
}

export type { Middleware, PayloadValidator, ValidationIssue, ValidatorResult };
export { httpTriggerMiddleware };
