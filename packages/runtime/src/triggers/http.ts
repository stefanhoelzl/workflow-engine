import { constants } from "node:http2";
import type {
	HttpTriggerResult,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Executor } from "../executor/index.js";
import type { HttpTriggerDescriptor } from "../executor/types.js";
import type { TriggerSource, TriggerViewEntry } from "./source.js";
import { validate } from "./validator.js";

// ---------------------------------------------------------------------------
// HTTP TriggerSource
// ---------------------------------------------------------------------------
//
// `createHttpTriggerSource` is the HTTP-kind protocol adapter. The source:
//   - Owns its internal URL-pattern map keyed by (tenant, workflow, path, method).
//   - Receives a kind-filtered view of HTTP descriptors via `reconfigure()`
//     on every workflow state change (the WorkflowRegistry pushes these).
//   - Exposes a Hono middleware mounted at `/webhooks/*` by `main.ts`.
//   - Validates incoming requests against `descriptor.inputSchema` via the
//     shared `validate()` function.
//   - Dispatches via `executor.invoke(tenant, workflow, descriptor, input,
//     bundleSource)` and serializes the executor's `{ ok, output }`
//     envelope as the HTTP response (200 default; 500 on error sentinel).

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
}

interface ValidationIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

const PARAM_SEGMENT_RE = /[:*]/;
const WILDCARD_SEGMENT_RE = /\*(\w+)/g;

function toUrlPatternPath(path: string): string {
	return path.replace(WILDCARD_SEGMENT_RE, ":$1+");
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

const WEBHOOKS_PREFIX = "/webhooks/";
const HTTP_NO_CONTENT =
	constants.HTTP_STATUS_NO_CONTENT as ContentfulStatusCode;
const HTTP_SERVICE_UNAVAILABLE =
	constants.HTTP_STATUS_SERVICE_UNAVAILABLE as ContentfulStatusCode;
const HTTP_UNPROCESSABLE_ENTITY =
	constants.HTTP_STATUS_UNPROCESSABLE_ENTITY as ContentfulStatusCode;
const DEFAULT_HTTP_STATUS = 200;
const HTTP_INTERNAL_ERROR = 500;
const TENANT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

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
		{ error: "payload_validation_failed", issues: issues ?? [] },
		HTTP_UNPROCESSABLE_ENTITY,
	);
}

function serializeHttpResult(c: Context, output: unknown): Response {
	const result = (output ?? {}) as HttpTriggerResult;
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

function internalErrorResponse(c: Context): Response {
	return c.json(
		{ error: "internal_error" },
		HTTP_INTERNAL_ERROR as ContentfulStatusCode,
	);
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

interface HttpTriggerSourceDeps {
	readonly executor: Executor;
}

interface HttpTriggerSource extends TriggerSource<"http"> {
	readonly middleware: Middleware;
}

interface SourceEntry {
	readonly tenant: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly descriptor: HttpTriggerDescriptor;
	readonly pattern: URLPattern;
	readonly isStatic: boolean;
}

interface SourceMatch {
	readonly tenant: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly descriptor: HttpTriggerDescriptor;
	readonly params: Record<string, string>;
}

interface LookupArgs {
	readonly entries: readonly SourceEntry[];
	readonly tenant: string;
	readonly workflowName: string;
	readonly path: string;
	readonly method: string;
}

function sourceLookup(args: LookupArgs): SourceMatch | undefined {
	const pathname = `/${args.path}`;
	const scoped = args.entries.filter(
		(e) => e.tenant === args.tenant && e.workflow.name === args.workflowName,
	);
	const inScope = (isStatic: boolean): SourceMatch | undefined => {
		for (const entry of scoped) {
			if (entry.isStatic !== isStatic) {
				continue;
			}
			if (entry.descriptor.method !== args.method) {
				continue;
			}
			const result = entry.pattern.exec({ pathname });
			if (!result) {
				continue;
			}
			return {
				tenant: entry.tenant,
				workflow: entry.workflow,
				bundleSource: entry.bundleSource,
				descriptor: entry.descriptor,
				params: extractParams(
					result.pathname.groups as Record<string, string | undefined>,
				),
			};
		}
	};
	return inScope(true) ?? inScope(false);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups source state, middleware handler, and TriggerSource lifecycle methods
function createHttpTriggerSource(
	deps: HttpTriggerSourceDeps,
): HttpTriggerSource {
	let entries: readonly SourceEntry[] = [];

	const middleware: Middleware = {
		match: `${WEBHOOKS_PREFIX}*`,
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the middleware handler fuses URL parsing, lookup, validation, and dispatch in sequence — splitting hurts readability
		// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the middleware handler is inherently a sequential pipeline
		handler: async (c: Context) => {
			const afterPrefix = c.req.path.slice(WEBHOOKS_PREFIX.length);

			if (afterPrefix === "" && c.req.method === "GET") {
				const status =
					entries.length > 0 ? HTTP_NO_CONTENT : HTTP_SERVICE_UNAVAILABLE;
				return c.body(null, status);
			}

			// Parse /webhooks/<tenant>/<workflow-name>/<trigger-path>
			const slashOne = afterPrefix.indexOf("/");
			if (slashOne <= 0) {
				return c.notFound();
			}
			const tenant = afterPrefix.slice(0, slashOne);
			const rest = afterPrefix.slice(slashOne + 1);
			const slashTwo = rest.indexOf("/");
			if (slashTwo <= 0) {
				return c.notFound();
			}
			const workflowName = rest.slice(0, slashTwo);
			const triggerPath = rest.slice(slashTwo + 1);
			if (!(TENANT_NAME_RE.test(tenant) && TENANT_NAME_RE.test(workflowName))) {
				return c.notFound();
			}

			const match = sourceLookup({
				entries,
				tenant,
				workflowName,
				path: triggerPath,
				method: c.req.method,
			});
			if (!match) {
				return c.notFound();
			}

			const bodyParse = await parseBody(c);
			if (!bodyParse.ok) {
				return validationFailure(c, bodyParse.issues);
			}
			const rawQuery = extractQueryParams(c.req.url);
			const rawInput = {
				body: bodyParse.value,
				headers: headersToRecord(c.req.raw.headers),
				url: c.req.url,
				method: c.req.method,
				params: match.params,
				query: rawQuery,
			};
			const validated = validate(match.descriptor, rawInput);
			if (!validated.ok) {
				return validationFailure(c, validated.issues);
			}
			const result = await deps.executor.invoke(
				match.tenant,
				match.workflow,
				match.descriptor,
				validated.input,
				match.bundleSource,
			);
			if (!result.ok) {
				return internalErrorResponse(c);
			}
			return serializeHttpResult(c, result.output);
		},
	};

	return {
		kind: "http",
		start() {
			return Promise.resolve();
		},
		stop() {
			entries = [];
			return Promise.resolve();
		},
		reconfigure(view: readonly TriggerViewEntry<"http">[]) {
			const next: SourceEntry[] = [];
			for (const entry of view) {
				const descriptor = entry.descriptor as HttpTriggerDescriptor;
				next.push({
					tenant: entry.tenant,
					workflow: entry.workflow,
					bundleSource: entry.bundleSource,
					descriptor,
					pattern: new URLPattern({
						pathname: `/${toUrlPatternPath(descriptor.path)}`,
					}),
					isStatic: !PARAM_SEGMENT_RE.test(descriptor.path),
				});
			}
			entries = next;
		},
		middleware,
	};
}

export type { HttpTriggerSource, Middleware, ValidationIssue };
export { createHttpTriggerSource };
