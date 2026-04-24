import type { DispatchMeta } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { ownerSet } from "../../auth/owner.js";
import { requireOwnerMember } from "../../auth/owner-mw.js";
import type {
	BaseTriggerDescriptor,
	HttpTriggerDescriptor,
} from "../../executor/types.js";
import { createNotFoundHandler } from "../../services/content-negotiation.js";
import type { Middleware } from "../../triggers/http.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { renderRepoTriggerPage, renderTriggerTreePage } from "./page.js";

// ---------------------------------------------------------------------------
// /trigger/* — operator UI for manually firing registered triggers
// ---------------------------------------------------------------------------
//
// Mirrors the dashboard's three-level drill-down:
//   GET /trigger                        — owners the caller can see
//   GET /trigger/:owner                 — repos under that owner
//   GET /trigger/:owner/:repo           — trigger cards for that repo
//   POST /trigger/:owner/:repo/:workflow/:trigger
//                                       — kind-agnostic manual fire
//
// HTTP-trigger cards still submit to `/trigger/:owner/:repo/<workflow>/
// <trigger>` so the session user can be captured as dispatch provenance
// (the public `/webhooks/...` URL remains the external entry point).
//
// SECURITY (§4): mounted under `/trigger/*`, which is protected by the
// in-app `sessionMw` that reads the sealed session cookie set by the
// auth capability (the oauth2-proxy forward-auth chain was removed by
// `replace-oauth2-proxy`). Cross-owner form submissions (which hit
// the public webhooks ingress) are still unauthenticated per §3.

interface TriggerMiddlewareDeps {
	readonly registry: WorkflowRegistry;
	// Session middleware mounted before the trigger handlers. Required
	// per `auth/spec.md` "sessionMw mount points": every route under
	// `/trigger/*` SHALL enforce session auth. Tests that do not exercise
	// the real `sessionMiddleware` inject a stub that seeds `UserContext`
	// on the request context via `c.set("user", …)`.
	readonly sessionMw: MiddlewareHandler;
}

const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;

function sortedOwners(c: Context): string[] {
	const user = c.get("user");
	return user ? Array.from(ownerSet(user)).sort() : [];
}

// biome-ignore lint/complexity/useMaxParams: wraps posted body into the kind-specific input shape; parts are already available at the call site
function wrapInputForDescriptor(
	descriptor: BaseTriggerDescriptor<string>,
	body: unknown,
	owner: string,
	repo: string,
	workflowName: string,
	triggerName: string,
): unknown {
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		// Server-side synthesis: build the full HttpTriggerPayload the HTTP
		// trigger backend would normally construct from a real webhook
		// request. Headers are intentionally empty (leaking dispatch-path
		// specifics into guest-visible headers would be wrong); url is the
		// canonical relative webhook path; method comes from the descriptor.
		return {
			body,
			headers: {},
			url: `/webhooks/${owner}/${repo}/${workflowName}/${triggerName}`,
			method: http.method,
		};
	}
	return body;
}

function buildDispatch(c: Context): DispatchMeta {
	const user = c.get("user");
	if (user && typeof user.login === "string" && typeof user.mail === "string") {
		return {
			source: "manual",
			user: { login: user.login, mail: user.mail },
		};
	}
	// Authentication is binary per `auth/spec.md`: either a `UserContext`
	// is set by `sessionMw` / bearer-auth, or it is not. There is no
	// `authOpen` open-mode flag. A missing user on `/trigger/*` in
	// production means the session middleware has already redirected the
	// caller to `/login`; reaching this branch is possible only in tests
	// that exercise the middleware without seeding `user`.
	return { source: "manual" };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires four GET drill-down levels plus the kind-agnostic POST; splitting fragments the handler flow
function triggerMiddleware(deps: TriggerMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/trigger");
	app.use("*", deps.sessionMw);
	app.use("/:owner/*", requireOwnerMember());
	app.use("/:owner", requireOwnerMember());
	app.use("/:owner/:repo/*", requireOwnerMember());
	app.use("/:owner/:repo", requireOwnerMember());
	app.notFound(createNotFoundHandler());

	const renderRoot = (c: Context) => {
		const user = c.get("user");
		const owners = sortedOwners(c);
		// Present each owner as a node; the repo list is lazy-loaded on
		// expand via /trigger/:owner when the user navigates there. With one
		// owner we send the operator straight to that owner's page for fewer
		// clicks.
		return c.html(
			renderTriggerTreePage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				reposByOwner: {},
			}),
		);
	};
	app.get("/", renderRoot);
	app.get("", renderRoot);

	app.get("/:owner", (c) => {
		const owner = c.req.param("owner");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const repos = deps.registry.repos(owner);
		return c.html(
			renderTriggerTreePage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				reposByOwner: { [owner]: repos },
				autoExpand: owner,
			}),
		);
	});

	app.get("/:owner/:repo", (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const user = c.get("user");
		const scopedEntries = deps.registry.list(owner, repo);
		const owners = sortedOwners(c);
		return c.html(
			renderRepoTriggerPage({
				entries: scopedEntries,
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				owner,
				repo,
			}),
		);
	});

	// POST /trigger/<owner>/<repo>/<workflow>/<triggerName> — kind-agnostic
	// manual fire. Validates JSON body against descriptor.inputSchema and
	// dispatches via the shared executor. Response returns `{ ok, output }`
	// on success or `{ error: "internal_error" }` on failure.
	app.post("/:owner/:repo/:workflow/:trigger", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const workflowName = c.req.param("workflow");
		const triggerName = c.req.param("trigger");

		const entry = deps.registry.getEntry(
			owner,
			repo,
			workflowName,
			triggerName,
		);
		if (!entry) {
			return c.notFound();
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(
				{
					error: "payload_validation_failed",
					issues: [{ path: ["body"], message: "Invalid JSON body" }],
				},
				HTTP_UNPROCESSABLE_ENTITY,
			);
		}

		const input = wrapInputForDescriptor(
			entry.descriptor,
			body,
			owner,
			repo,
			workflowName,
			triggerName,
		);
		const dispatch = buildDispatch(c);
		const result = await entry.fire(input, dispatch);
		if (!result.ok) {
			if (result.error.issues) {
				return c.json(
					{
						error: "payload_validation_failed",
						issues: result.error.issues,
					},
					HTTP_UNPROCESSABLE_ENTITY,
				);
			}
			return c.json(
				{ error: "internal_error", details: result.error },
				HTTP_INTERNAL_ERROR,
			);
		}
		return c.json({ ok: true, output: result.output });
	});

	return {
		match: "/trigger/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { TriggerMiddlewareDeps };
export { triggerMiddleware };
