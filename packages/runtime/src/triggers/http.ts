import { constants } from "node:http2";
import type { HttpTriggerResult } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Executor } from "../executor/index.js";
import type {
	HttpTriggerDescriptor,
	WorkflowRunner,
} from "../executor/types.js";

// ---------------------------------------------------------------------------
// HTTP trigger registry + middleware (v1, executor-backed)
// ---------------------------------------------------------------------------
//
// The registry stores one entry per (workflow, trigger) pair with a compiled
// URLPattern. `lookup(path, method)` returns the first match, preferring
// static paths over parameterized ones (http-trigger spec). The middleware:
//   1. Handles GET /webhooks/ health probe (204 if any trigger registered,
//      503 otherwise).
//   2. Looks up the matched trigger, returns 404 if none.
//   3. Parses JSON body; 422 on parse failure.
//   4. Builds payload {body, headers, url, method, params, query}.
//   5. Validates payload against the trigger's registered validator; 422 on
//      failure with {error, issues}.
//   6. Calls executor.invoke(workflow, trigger.name, payload); serializes
//      the returned HttpTriggerResult as the HTTP response (200/""/{}
//      defaults applied by the executor per D5/D13).

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
// Registry definition (internal)
// ---------------------------------------------------------------------------

const PARAM_SEGMENT_RE = /[:*]/;
const WILDCARD_SEGMENT_RE = /\*(\w+)/g;

function toUrlPatternPath(path: string): string {
	return path.replace(WILDCARD_SEGMENT_RE, ":$1+");
}

interface RegisteredTrigger {
	readonly workflow: WorkflowRunner;
	readonly descriptor: HttpTriggerDescriptor;
	readonly validator: PayloadValidator;
	readonly pattern: URLPattern;
	readonly isStatic: boolean;
	readonly schema?: Record<string, unknown>;
}

interface TriggerMatch {
	readonly workflow: WorkflowRunner;
	readonly descriptor: HttpTriggerDescriptor;
	readonly validator: PayloadValidator;
	readonly params: Record<string, string>;
}

interface HttpTriggerEntry {
	readonly workflow: WorkflowRunner;
	readonly descriptor: HttpTriggerDescriptor;
	// Full composite payload JSON Schema (body + headers + url + method +
	// params + query) from the manifest. Used by the trigger UI to render
	// the form. Optional because test fixtures may omit it.
	readonly schema?: Record<string, unknown>;
}

interface HttpTriggerRegisterOptions {
	readonly schema?: Record<string, unknown>;
}

interface HttpTriggerRegistry {
	register(
		workflow: WorkflowRunner,
		descriptor: HttpTriggerDescriptor,
		validator: PayloadValidator,
		options?: HttpTriggerRegisterOptions,
	): void;
	// Removes every trigger entry owned by the given workflow name. Used by
	// the upload pipeline when a workflow is replaced (re-registered) so the
	// old triggers don't linger alongside the new ones.
	removeWorkflow(workflowName: string): void;
	lookup(path: string, method: string): TriggerMatch | undefined;
	// Read-only view for UI rendering. Returns a snapshot array so callers
	// can iterate without risking mutation of the registry's internals.
	list(): HttpTriggerEntry[];
	readonly size: number;
}

function extractParams(
	groups: Record<string, string | undefined>,
): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(groups)) {
		if (value !== undefined) {
			params[key] = value;
		}
	}
	return params;
}

function tryMatch(
	entry: RegisteredTrigger,
	pathname: string,
	method: string,
	isStatic: boolean,
): TriggerMatch | undefined {
	if (entry.isStatic !== isStatic) {
		return;
	}
	if (entry.descriptor.method !== method) {
		return;
	}
	const result = entry.pattern.exec({ pathname });
	if (!result) {
		return;
	}
	return {
		workflow: entry.workflow,
		descriptor: entry.descriptor,
		validator: entry.validator,
		params: extractParams(
			result.pathname.groups as Record<string, string | undefined>,
		),
	};
}

function createHttpTriggerRegistry(): HttpTriggerRegistry {
	const entries: RegisteredTrigger[] = [];

	function matchAt(
		pathname: string,
		method: string,
		isStatic: boolean,
	): TriggerMatch | undefined {
		for (const entry of entries) {
			const match = tryMatch(entry, pathname, method, isStatic);
			if (match) {
				return match;
			}
		}
	}

	return {
		register(workflow, descriptor, validator, options) {
			const entry: RegisteredTrigger = {
				workflow,
				descriptor,
				validator,
				pattern: new URLPattern({
					pathname: `/${toUrlPatternPath(descriptor.path)}`,
				}),
				isStatic: !PARAM_SEGMENT_RE.test(descriptor.path),
				...(options?.schema ? { schema: options.schema } : {}),
			};
			entries.push(entry);
		},
		removeWorkflow(workflowName: string) {
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.workflow.name === workflowName) {
					entries.splice(i, 1);
				}
			}
		},
		lookup(path, method) {
			const pathname = `/${path}`;
			// Static triggers take priority over parameterized.
			return (
				matchAt(pathname, method, true) ?? matchAt(pathname, method, false)
			);
		},
		list() {
			return entries.map((e) => ({
				workflow: e.workflow,
				descriptor: e.descriptor,
				...(e.schema ? { schema: e.schema } : {}),
			}));
		},
		get size(): number {
			return entries.length;
		},
	};
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
	// Preserve existing default body shape: if the caller returns a string,
	// ship it as-is; for object/array returns, JSON-stringify (matching
	// c.json). Headers defaulting, plus Content-Type, are handled per-branch.
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
	match: TriggerMatch,
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
	match: TriggerMatch,
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
		match.workflow,
		match.descriptor.name,
		payload,
	);
	return serializeHttpResult(c, result);
}

function httpTriggerMiddleware(
	source: { readonly triggerRegistry: HttpTriggerRegistry },
	executor: Executor,
): Middleware {
	return {
		match: `${WEBHOOKS_PREFIX}*`,
		handler: (c: Context) => {
			const triggerPath = c.req.path.slice(WEBHOOKS_PREFIX.length);

			if (triggerPath === "" && c.req.method === "GET") {
				const status =
					source.triggerRegistry.size > 0
						? HTTP_NO_CONTENT
						: HTTP_SERVICE_UNAVAILABLE;
				return Promise.resolve(c.body(null, status));
			}

			const match = source.triggerRegistry.lookup(triggerPath, c.req.method);
			if (!match) {
				return Promise.resolve(c.notFound());
			}
			return handleTriggerRequest(c, match, executor);
		},
	};
}

export type {
	HttpTriggerEntry,
	HttpTriggerRegistry,
	Middleware,
	PayloadValidator,
	TriggerMatch,
	ValidationIssue,
	ValidatorResult,
};
export { createHttpTriggerRegistry, httpTriggerMiddleware };
