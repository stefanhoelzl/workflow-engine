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
import { buildSidebarData, SidebarTree } from "../sidebar-tree.js";
import { Tabs } from "../tabs.js";
import { renderScopeTriggerPage, renderSingleTriggerPage } from "./page.js";

// ---------------------------------------------------------------------------
// /trigger/* — operator UI for manually firing registered triggers
// ---------------------------------------------------------------------------
//
// Scope-filtered routes mirror the dashboard surface; navigation is driven
// by the shared sidebar tree, not by inline-expansion in the main view.
//   GET /trigger                              — every card across user's owners
//   GET /trigger/:owner                       — every card under owner
//   GET /trigger/:owner/:repo                 — repo's cards by workflow
//   GET /trigger/:owner/:repo/:workflow       — workflow's cards
//   GET /trigger/:owner/:repo/:workflow/:trigger — focused single card
//   POST /trigger/:owner/:repo/:workflow/:trigger — kind-agnostic manual fire
//
// HTTP-trigger cards still submit to the kind-agnostic /trigger/* endpoint
// so the session user is captured as dispatch provenance (the public
// /webhooks/... URL remains the external ingress).
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

function isEnvelope(
	value: unknown,
): value is { body?: unknown; headers?: Record<string, string> } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const v = value as Record<string, unknown>;
	const ks = Object.keys(v);
	// Treat as envelope only when at least one of `body`/`headers` is present
	// AND every present key is one of {body, headers}. A bare body that
	// happens to contain a `body` field (e.g. `{ body: "comment text" }`) is
	// still treated as bare unless `headers` is also present.
	const hasEnvelopeKey = "headers" in v;
	if (!hasEnvelopeKey) {
		return false;
	}
	for (const k of ks) {
		if (k !== "body" && k !== "headers") {
			return false;
		}
	}
	return true;
}

// biome-ignore lint/complexity/useMaxParams: wraps posted body into the kind-specific input shape; parts are already available at the call site
function wrapInputForDescriptor(
	descriptor: BaseTriggerDescriptor<string>,
	posted: unknown,
	owner: string,
	repo: string,
	workflowName: string,
	triggerName: string,
): unknown {
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		// Server-side synthesis: build the full HttpTriggerPayload the HTTP
		// trigger backend would normally construct from a real webhook
		// request. Accept either a bare body (today's shape, when the trigger
		// declares no headers schema) or a `{body, headers}` envelope (when
		// the card collects header inputs from a declared headers schema).
		// url is the canonical relative webhook path; method comes from the
		// descriptor.
		let body: unknown;
		let headers: Record<string, string> = {};
		if (isEnvelope(posted)) {
			body = posted.body;
			if (posted.headers && typeof posted.headers === "object") {
				headers = posted.headers as Record<string, string>;
			}
		} else {
			body = posted;
		}
		return {
			body,
			headers,
			url: `/webhooks/${owner}/${repo}/${workflowName}/${triggerName}`,
			method: http.method,
		};
	}
	if (descriptor.kind === "ws") {
		// Manual-fire of a wsTrigger reshapes the submitted JSON to the
		// `{data}` payload the handler receives over the wire. The raw socket
		// equivalent fires once per inbound frame; the UI submits one input
		// at a time. Identity does not survive — `dispatch.source` becomes
		// `manual` per `buildDispatch` (no client connection involved).
		return { data: posted };
	}
	return posted;
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires four GET drill-down levels + two HTMX fragments + kind-agnostic POST; splitting fragments the handler flow
function triggerMiddleware(deps: TriggerMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/trigger");
	app.use("*", deps.sessionMw);
	app.use("/:owner/*", requireOwnerMember());
	app.use("/:owner", requireOwnerMember());
	app.use("/:owner/:repo/*", requireOwnerMember());
	app.use("/:owner/:repo", requireOwnerMember());
	app.notFound(createNotFoundHandler());

	// biome-ignore lint/complexity/useMaxParams: active-state fields are orthogonal URL facets
	function buildSidebar(
		owners: readonly string[],
		activeOwner?: string,
		activeRepo?: string,
		activeWorkflow?: string,
		activeTrigger?: string,
	) {
		const data = buildSidebarData(deps.registry, owners);
		return (
			<SidebarTree
				surface="/trigger"
				data={data}
				active={{
					...(activeOwner ? { owner: activeOwner } : {}),
					...(activeRepo ? { repo: activeRepo } : {}),
					...(activeWorkflow ? { workflow: activeWorkflow } : {}),
					...(activeTrigger ? { trigger: activeTrigger } : {}),
				}}
			/>
		);
	}

	function tabsFor(
		activeOwner?: string,
		activeRepo?: string,
		activeWorkflow?: string,
		activeTrigger?: string,
	) {
		const path = `/${[activeOwner, activeRepo, activeWorkflow, activeTrigger]
			.filter((s): s is string => Boolean(s))
			.join("/")}`;
		const cleaned = path === "/" ? "" : path;
		return <Tabs surface="/trigger" path={cleaned} />;
	}

	function entriesAcrossOwners(
		owners: readonly string[],
	): readonly import("../../workflow-registry.js").WorkflowEntry[] {
		const out: import("../../workflow-registry.js").WorkflowEntry[] = [];
		for (const o of owners) {
			for (const repo of deps.registry.repos(o)) {
				for (const entry of deps.registry.list(o, repo)) {
					out.push(entry);
				}
			}
		}
		return out;
	}

	// -- Root: /trigger ----------------------------------------------------
	const renderRoot = (c: Context) => {
		const user = c.get("user");
		const owners = sortedOwners(c);
		const entries = entriesAcrossOwners(owners);
		return c.html(
			renderScopeTriggerPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				entries,
				scope: {},
				sidebarTree: buildSidebar(owners),
				tabs: tabsFor(),
			}),
		);
	};
	app.get("/", renderRoot);
	app.get("", renderRoot);

	// -- /trigger/:owner -- every trigger card across owner's repos -------
	app.get("/:owner", (c) => {
		const owner = c.req.param("owner");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const repos = deps.registry.repos(owner);
		const entries: import("../../workflow-registry.js").WorkflowEntry[] = [];
		for (const repo of repos) {
			for (const entry of deps.registry.list(owner, repo)) {
				entries.push(entry);
			}
		}
		return c.html(
			renderScopeTriggerPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				entries,
				scope: { owner },
				sidebarTree: buildSidebar(owners, owner),
				tabs: tabsFor(owner),
			}),
		);
	});

	// -- /trigger/:owner/:repo -- repo's cards grouped by workflow --------
	app.get("/:owner/:repo", (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const entries = deps.registry.list(owner, repo);
		return c.html(
			renderScopeTriggerPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				entries,
				scope: { owner, repo },
				sidebarTree: buildSidebar(owners, owner, repo),
				tabs: tabsFor(owner, repo),
			}),
		);
	});

	// -- /trigger/:owner/:repo/:workflow -- one workflow's cards ----------
	app.get("/:owner/:repo/:workflow", (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const workflow = c.req.param("workflow");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const entries = deps.registry
			.list(owner, repo)
			.filter((e) => e.workflow.name === workflow);
		if (entries.length === 0) {
			return c.notFound();
		}
		return c.html(
			renderScopeTriggerPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				entries,
				scope: { owner, repo, workflow },
				sidebarTree: buildSidebar(owners, owner, repo, workflow),
				tabs: tabsFor(owner, repo, workflow),
			}),
		);
	});

	// -- /trigger/:owner/:repo/:workflow/:trigger -- single-trigger page -
	// Renders only the named trigger's card, pre-expanded. The same path
	// also handles POST (manual fire) further down; Hono dispatches by
	// method.
	app.get("/:owner/:repo/:workflow/:trigger", (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const workflow = c.req.param("workflow");
		const trigger = c.req.param("trigger");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const entries = deps.registry.list(owner, repo);
		return c.html(
			renderSingleTriggerPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				owner,
				repo,
				workflow,
				trigger,
				entries,
				sidebarTree: buildSidebar(owners, owner, repo, workflow, trigger),
				tabs: tabsFor(owner, repo, workflow, trigger),
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
