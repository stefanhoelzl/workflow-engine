import { constants } from "node:http2";
import type { HttpTriggerResult } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
	HttpTriggerDescriptor,
	ValidationIssue,
} from "../executor/types.js";
import type {
	ReconfigureResult,
	TriggerConfigError,
	TriggerEntry,
	TriggerSource,
} from "./source.js";

// ---------------------------------------------------------------------------
// HTTP TriggerSource
// ---------------------------------------------------------------------------
//
// `createHttpTriggerSource` is the HTTP-kind protocol adapter. The source:
//   - Owns a per-tenant URL-pattern index keyed by (workflow, method, path).
//   - Receives `reconfigure(tenant, entries)` from the WorkflowRegistry on
//     every tenant upload. Entries for other tenants are untouched.
//   - Exposes a Hono middleware mounted at `/webhooks/*` by `main.ts`.
//   - Normalizes HTTP requests into `{body, headers, url, method, params,
//     query}` and calls `entry.fire(input)`. Input-schema validation and
//     executor dispatch happen inside the `fire` closure (see buildFire).
//   - Maps `InvokeResult` back into the HTTP response: 200+output on
//     success; 422+issues when `error.issues` is set (validation failure);
//     500 otherwise.

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
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
	issues: readonly ValidationIssue[] | undefined,
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

interface HttpTriggerSource
	extends TriggerSource<"http", HttpTriggerDescriptor> {
	readonly middleware: Middleware;
	getEntry(
		tenant: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry<HttpTriggerDescriptor> | undefined;
}

interface TenantEntry {
	readonly entry: TriggerEntry<HttpTriggerDescriptor>;
	readonly pattern: URLPattern;
	readonly isStatic: boolean;
}

interface TenantState {
	readonly byTrigger: Map<string, TenantEntry>;
	readonly list: readonly TenantEntry[];
}

interface LookupArgs {
	readonly state: TenantState;
	readonly workflowName: string;
	readonly path: string;
	readonly method: string;
}

interface LookupMatch {
	readonly tenantEntry: TenantEntry;
	readonly params: Record<string, string>;
}

function sourceLookup(args: LookupArgs): LookupMatch | undefined {
	const pathname = `/${args.path}`;
	const scoped = args.state.list.filter(
		(e) => e.entry.descriptor.workflowName === args.workflowName,
	);
	const inScope = (isStatic: boolean): LookupMatch | undefined => {
		for (const tenantEntry of scoped) {
			if (tenantEntry.isStatic !== isStatic) {
				continue;
			}
			if (tenantEntry.entry.descriptor.method !== args.method) {
				continue;
			}
			const result = tenantEntry.pattern.exec({ pathname });
			if (!result) {
				continue;
			}
			return {
				tenantEntry,
				params: extractParams(
					result.pathname.groups as Record<string, string | undefined>,
				),
			};
		}
	};
	return inScope(true) ?? inScope(false);
}

function buildTenantEntry(
	entry: TriggerEntry<HttpTriggerDescriptor>,
): TenantEntry {
	const descriptor = entry.descriptor;
	return {
		entry,
		pattern: new URLPattern({
			pathname: `/${toUrlPatternPath(descriptor.path)}`,
		}),
		isStatic: !PARAM_SEGMENT_RE.test(descriptor.path),
	};
}

function makeRouteKey(d: HttpTriggerDescriptor): string {
	return `${d.workflowName}|${d.method}|${d.path}`;
}

function makeTriggerKey(workflowName: string, triggerName: string): string {
	return `${workflowName}/${triggerName}`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups source state, middleware handler, and TriggerSource lifecycle methods
function createHttpTriggerSource(): HttpTriggerSource {
	const tenants = new Map<string, TenantState>();

	const middleware: Middleware = {
		match: `${WEBHOOKS_PREFIX}*`,
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the middleware handler fuses URL parsing, lookup, body parse, and dispatch in sequence — splitting fragments the request flow
		handler: async (c: Context) => {
			const afterPrefix = c.req.path.slice(WEBHOOKS_PREFIX.length);

			if (afterPrefix === "" && c.req.method === "GET") {
				const hasAny = [...tenants.values()].some((s) => s.list.length > 0);
				const status = hasAny ? HTTP_NO_CONTENT : HTTP_SERVICE_UNAVAILABLE;
				return c.body(null, status);
			}

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

			const state = tenants.get(tenant);
			if (!state) {
				return c.notFound();
			}

			const match = sourceLookup({
				state,
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
			const result = await match.tenantEntry.entry.fire(rawInput);
			if (!result.ok) {
				if (result.error.issues) {
					return validationFailure(c, result.error.issues);
				}
				return internalErrorResponse(c);
			}
			return serializeHttpResult(c, result.output);
		},
	};

	function detectConflicts(
		tenant: string,
		list: readonly TenantEntry[],
	): readonly TriggerConfigError[] {
		const seen = new Set<string>();
		const errors: TriggerConfigError[] = [];
		for (const te of list) {
			const d = te.entry.descriptor;
			const key = makeRouteKey(d);
			if (seen.has(key)) {
				errors.push({
					backend: "http",
					trigger: d.name,
					message:
						'duplicate HTTP route for tenant "' +
						tenant +
						'" workflow "' +
						d.workflowName +
						'": ' +
						d.method +
						" " +
						d.path,
				});
			} else {
				seen.add(key);
			}
		}
		return errors;
	}

	return {
		kind: "http",
		start() {
			return Promise.resolve();
		},
		stop() {
			tenants.clear();
			return Promise.resolve();
		},
		reconfigure(
			tenant: string,
			entries: readonly TriggerEntry<HttpTriggerDescriptor>[],
		): Promise<ReconfigureResult> {
			if (entries.length === 0) {
				tenants.delete(tenant);
				return Promise.resolve({ ok: true });
			}
			const list: TenantEntry[] = [];
			const byTrigger = new Map<string, TenantEntry>();
			for (const e of entries) {
				const te = buildTenantEntry(e);
				list.push(te);
				byTrigger.set(
					makeTriggerKey(e.descriptor.workflowName, e.descriptor.name),
					te,
				);
			}
			const errors = detectConflicts(tenant, list);
			if (errors.length > 0) {
				return Promise.resolve({ ok: false, errors });
			}
			tenants.set(tenant, { byTrigger, list });
			return Promise.resolve({ ok: true });
		},
		getEntry(tenant, workflowName, triggerName) {
			const state = tenants.get(tenant);
			return state?.byTrigger.get(makeTriggerKey(workflowName, triggerName))
				?.entry;
		},
		middleware,
	};
}

export type { HttpTriggerSource, Middleware };
export { createHttpTriggerSource };
