import { constants } from "node:http2";
import {
	type HttpTriggerResult,
	OWNER_NAME_RE,
	REPO_NAME_RE,
	TRIGGER_NAME_RE,
} from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
	HttpTriggerDescriptor,
	ValidationIssue,
} from "../executor/types.js";
import type {
	ReconfigureResult,
	TriggerEntry,
	TriggerSource,
} from "./source.js";

// ---------------------------------------------------------------------------
// HTTP TriggerSource
// ---------------------------------------------------------------------------
//
// `createHttpTriggerSource` is the HTTP-kind protocol adapter. The source:
//   - Owns a per-(owner, repo) `Map` keyed by `(workflowName, triggerName)`.
//   - Receives `reconfigure(owner, repo, entries)` from the WorkflowRegistry
//     on every repo upload; entries for other (owner, repo) pairs are
//     untouched.
//   - Exposes a Hono middleware mounted at `/webhooks/*` by `main.ts`.
//   - Normalizes HTTP requests into `{body, headers, url, method}` and
//     calls `entry.fire(input)`. Input-schema validation and executor
//     dispatch happen inside the `fire` closure (buildFire in the registry).
//   - Maps `InvokeResult` back to the HTTP response: 200+output on success;
//     422+issues when `error.issues` is set (validation failure); 500
//     otherwise.
//
// The URL is mechanical: `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>`.
// Four segments, each regex-constrained. No author-chosen path string, no
// parameterized segments, no wildcards. Route collisions are impossible by
// JS export-name uniqueness inside a (owner, repo) scope, so the source has
// no conflict-detection pass on reconfigure. See the `http-trigger`
// capability spec.

interface Middleware {
	match: string;
	handler: MiddlewareHandler;
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
// The webhook URL is exactly `/webhooks/<owner>/<repo>/<workflow>/
// <trigger-name>` — four segments after the prefix, no more, no less.
const URL_SEGMENT_COUNT = 4;

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
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		return { ok: true, value: null };
	}
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
		owner: string,
		repo: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry<HttpTriggerDescriptor> | undefined;
	markReady(): void;
}

function triggerKey(workflowName: string, triggerName: string): string {
	return `${workflowName}/${triggerName}`;
}

function pairKey(owner: string, repo: string): string {
	// `/` cannot appear in either segment (validated by regexes) so this is
	// injection-safe.
	return `${owner}/${repo}`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups source state, middleware handler, and TriggerSource lifecycle methods
function createHttpTriggerSource(): HttpTriggerSource {
	const pairs = new Map<
		string,
		Map<string, TriggerEntry<HttpTriggerDescriptor>>
	>();
	let ready = false;

	const middleware: Middleware = {
		match: `${WEBHOOKS_PREFIX}*`,
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the middleware handler fuses URL parsing, lookup, body parse, and dispatch in sequence — splitting fragments the request flow
		// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same — single-request pipeline with four short phases
		handler: async (c: Context) => {
			const afterPrefix = c.req.path.slice(WEBHOOKS_PREFIX.length);

			if (afterPrefix === "" && c.req.method === "GET") {
				const status = ready ? HTTP_NO_CONTENT : HTTP_SERVICE_UNAVAILABLE;
				return c.body(null, status);
			}

			// Parse /webhooks/<owner>/<repo>/<workflow>/<trigger-name> — exactly
			// four segments, each regex-constrained. Any other shape → 404.
			const segments = afterPrefix.split("/");
			if (segments.length !== URL_SEGMENT_COUNT) {
				return c.notFound();
			}
			const [owner, repo, workflowName, triggerName] = segments as [
				string,
				string,
				string,
				string,
			];
			if (
				!(
					OWNER_NAME_RE.test(owner) &&
					REPO_NAME_RE.test(repo) &&
					OWNER_NAME_RE.test(workflowName) &&
					TRIGGER_NAME_RE.test(triggerName)
				)
			) {
				return c.notFound();
			}

			const byTrigger = pairs.get(pairKey(owner, repo));
			const entry = byTrigger?.get(triggerKey(workflowName, triggerName));
			if (!entry || entry.descriptor.method !== c.req.method) {
				return c.notFound();
			}

			const bodyParse = await parseBody(c);
			if (!bodyParse.ok) {
				return validationFailure(c, bodyParse.issues);
			}
			const rawInput = {
				body: bodyParse.value,
				headers: headersToRecord(c.req.raw.headers),
				url: c.req.url,
				method: c.req.method,
			};
			// No dispatch argument — public /webhooks/* ingress is
			// intentionally unauthenticated (SECURITY.md §3) so we cannot
			// attribute this to a user. The executor defaults to
			// `{ source: "trigger" }`, which is the correct provenance for
			// every external webhook call.
			const result = await entry.fire(rawInput);
			if (!result.ok) {
				if (result.error.issues) {
					return validationFailure(c, result.error.issues);
				}
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
			pairs.clear();
			return Promise.resolve();
		},
		reconfigure(
			owner: string,
			repo: string,
			entries: readonly TriggerEntry<HttpTriggerDescriptor>[],
		): Promise<ReconfigureResult> {
			const key = pairKey(owner, repo);
			if (entries.length === 0) {
				pairs.delete(key);
				return Promise.resolve({ ok: true });
			}
			const byTrigger = new Map<string, TriggerEntry<HttpTriggerDescriptor>>();
			for (const e of entries) {
				byTrigger.set(
					triggerKey(e.descriptor.workflowName, e.descriptor.name),
					e,
				);
			}
			pairs.set(key, byTrigger);
			return Promise.resolve({ ok: true });
		},
		getEntry(owner, repo, workflowName, triggerName) {
			return pairs
				.get(pairKey(owner, repo))
				?.get(triggerKey(workflowName, triggerName));
		},
		markReady() {
			ready = true;
		},
		middleware,
	};
}

export type { HttpTriggerSource, Middleware };
export { createHttpTriggerSource };
