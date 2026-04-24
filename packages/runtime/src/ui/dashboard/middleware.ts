import type { InvocationEvent } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { ownerSet } from "../../auth/owner.js";
import { requireOwnerMember } from "../../auth/owner-mw.js";
import { resolveQueryScopes } from "../../auth/scopes.js";
import type { EventStore, Scope } from "../../event-bus/event-store.js";
import type { Logger } from "../../logger.js";
import { createNotFoundHandler } from "../../services/content-negotiation.js";
import type { Middleware } from "../../triggers/http.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { renderFlamegraph } from "./flamegraph.js";
import type { InvocationRow } from "./page.js";
import {
	renderDashboardPage,
	renderInvocationList,
	renderRepoList,
} from "./page.js";

const DEFAULT_LIMIT = 100;

interface DashboardMiddlewareDeps {
	readonly eventStore: EventStore;
	readonly registry: WorkflowRegistry;
	readonly limit?: number;
	readonly logger?: Logger;
	// Session middleware mounted before the dashboard handlers. Required
	// per `auth/spec.md` "sessionMw mount points": every route under
	// `/dashboard/*` SHALL enforce session auth. Tests that do not
	// exercise the real `sessionMiddleware` inject a stub that seeds
	// `UserContext` on the request context via `c.set("user", …)`.
	readonly sessionMw: MiddlewareHandler;
}

interface RawRequestRow {
	id: string;
	workflow: string;
	name: string;
	at: string;
	ts: number | bigint;
	meta: unknown;
}

interface RawTerminalRow {
	id: string;
	kind: string;
	at: string;
	ts: number | bigint;
	error: unknown;
}

function toNumber(value: number | bigint): number {
	return typeof value === "bigint" ? Number(value) : value;
}

function statusFromTerminal(kind: string | undefined): string {
	if (kind === "trigger.response") {
		return "succeeded";
	}
	if (kind === "trigger.error") {
		return "failed";
	}
	return "pending";
}

function userOwners(c: Context): string[] {
	const user = c.get("user");
	return user ? Array.from(ownerSet(user)).sort() : [];
}

// biome-ignore lint/complexity/useMaxParams: lookup fans in on four orthogonal identifiers
function lookupTriggerKind(
	registry: WorkflowRegistry,
	owner: string,
	repo: string,
	workflow: string,
	triggerName: string,
): string | undefined {
	for (const entry of registry.list(owner, repo)) {
		if (entry.workflow.name !== workflow) {
			continue;
		}
		const descriptor = entry.triggers.find((t) => t.name === triggerName);
		return descriptor?.kind;
	}
}

// biome-ignore lint/complexity/useMaxParams: scope + pagination metadata are orthogonal
async function fetchInvocationRows(
	eventStore: EventStore,
	registry: WorkflowRegistry,
	owner: string,
	repo: string,
	limit: number,
): Promise<InvocationRow[]> {
	const scope: Scope = { owner, repo };
	const requests = (await eventStore
		.query([scope])
		.where("kind", "=", "trigger.request")
		.select(["id", "workflow", "name", "at", "ts", "meta"])
		.orderBy("at", "desc")
		.orderBy("id", "desc")
		.limit(limit)
		.execute()) as RawRequestRow[];

	const ids = requests.map((r) => r.id);
	const terminals =
		ids.length === 0
			? []
			: ((await eventStore
					.query([scope])
					.where("kind", "in", ["trigger.response", "trigger.error"])
					.where("id", "in", ids)
					.select(["id", "kind", "at", "ts", "error"])
					.execute()) as RawTerminalRow[]);

	const terminalById = new Map<string, RawTerminalRow>();
	for (const t of terminals) {
		terminalById.set(t.id, t);
	}

	return requests.map((r) => {
		const t = terminalById.get(r.id);
		const kind = lookupTriggerKind(registry, owner, repo, r.workflow, r.name);
		const dispatch = extractDispatch(r.meta);
		const row: InvocationRow = {
			id: r.id,
			owner,
			repo,
			workflow: r.workflow,
			trigger: r.name,
			status: statusFromTerminal(t?.kind),
			startedAt: r.at,
			completedAt: t?.at ?? null,
			startedTs: toNumber(r.ts),
			completedTs: t ? toNumber(t.ts) : null,
			...(kind ? { triggerKind: kind } : {}),
			...(dispatch ? { dispatch } : {}),
		};
		return row;
	});
}

function extractDispatch(
	rawMeta: unknown,
): InvocationRow["dispatch"] | undefined {
	const meta = parseJsonField(rawMeta);
	if (!meta || typeof meta !== "object") {
		return;
	}
	const dispatch = (meta as { dispatch?: unknown }).dispatch;
	if (!dispatch || typeof dispatch !== "object") {
		return;
	}
	const d = dispatch as { source?: unknown; user?: { login?: unknown } };
	if (d.source !== "manual" && d.source !== "trigger") {
		return;
	}
	const userLogin =
		d.user && typeof d.user.login === "string" ? d.user.login : undefined;
	return {
		source: d.source,
		...(userLogin ? { user: { login: userLogin } } : {}),
	};
}

async function fetchInvocationEvents(
	eventStore: EventStore,
	id: string,
	owner: string,
	repo: string,
): Promise<InvocationEvent[]> {
	const rows = (await eventStore
		.query([{ owner, repo }])
		.where("id", "=", id)
		.selectAll()
		.orderBy("seq", "asc")
		.execute()) as Record<string, unknown>[];
	return rows.map(rowToEvent);
}

function rowToEvent(row: Record<string, unknown>): InvocationEvent {
	const base = {
		kind: row.kind as InvocationEvent["kind"],
		id: row.id as string,
		owner: row.owner as string,
		repo: row.repo as string,
		seq: Number(row.seq),
		ref: row.ref === null || row.ref === undefined ? null : Number(row.ref),
		at: row.at as string,
		ts: toNumber(row.ts as number | bigint),
		workflow: row.workflow as string,
		workflowSha: row.workflowSha as string,
		name: row.name as string,
	};
	const input = parseJsonField(row.input);
	const output = parseJsonField(row.output);
	const error = parseJsonField(row.error) as
		| InvocationEvent["error"]
		| undefined;
	const meta = parseJsonField(row.meta) as InvocationEvent["meta"] | undefined;
	return {
		...base,
		...(input === undefined ? {} : { input }),
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
		...(meta === undefined ? {} : { meta }),
	};
}

function parseJsonField(value: unknown): unknown {
	if (value === null || value === undefined) {
		return;
	}
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

interface OwnerSummary {
	readonly owner: string;
	readonly count: number;
}

interface RepoSummary {
	readonly owner: string;
	readonly repo: string;
	readonly count: number;
}

async function aggregateOwnerCounts(
	eventStore: EventStore,
	scopes: readonly Scope[],
): Promise<OwnerSummary[]> {
	if (scopes.length === 0) {
		return [];
	}
	const rows = (await eventStore
		.query(scopes)
		.where("kind", "=", "trigger.request")
		.select(["owner"])
		.execute()) as Array<{ owner: string }>;
	const counts = new Map<string, number>();
	for (const r of rows) {
		counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
	}
	// Also ensure every scoped owner appears, even with zero invocations.
	const owners = new Set<string>();
	for (const s of scopes) {
		owners.add(s.owner);
	}
	return Array.from(owners)
		.sort()
		.map((owner) => ({ owner, count: counts.get(owner) ?? 0 }));
}

async function aggregateRepoCounts(
	eventStore: EventStore,
	scopes: readonly Scope[],
): Promise<RepoSummary[]> {
	if (scopes.length === 0) {
		return [];
	}
	const rows = (await eventStore
		.query(scopes)
		.where("kind", "=", "trigger.request")
		.select(["owner", "repo"])
		.execute()) as Array<{ owner: string; repo: string }>;
	const counts = new Map<string, number>();
	for (const r of rows) {
		counts.set(
			`${r.owner}/${r.repo}`,
			(counts.get(`${r.owner}/${r.repo}`) ?? 0) + 1,
		);
	}
	return scopes
		.slice()
		.sort((a, b) =>
			a.owner === b.owner
				? a.repo.localeCompare(b.repo)
				: a.owner.localeCompare(b.owner),
		)
		.map((s) => ({
			owner: s.owner,
			repo: s.repo,
			count: counts.get(`${s.owner}/${s.repo}`) ?? 0,
		}));
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires the full three-level drill-down plus fragment endpoints and the flamegraph handler; splitting fragments the request flow
function dashboardMiddleware(deps: DashboardMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/dashboard");
	app.use("*", deps.sessionMw);
	// Guard every sub-route that names an :owner (with optional :repo). The
	// root /dashboard is intentionally unguarded: it just renders the shell
	// scoped to the user's owner allow-set.
	app.use("/:owner/*", requireOwnerMember());
	app.use("/:owner", requireOwnerMember());
	app.use("/:owner/:repo/*", requireOwnerMember());
	app.use("/:owner/:repo", requireOwnerMember());
	app.notFound(createNotFoundHandler());
	const limit = deps.limit ?? DEFAULT_LIMIT;
	const logger = deps.logger;

	// -- Root: /dashboard --------------------------------------------------
	const renderRoot = async (c: Context) => {
		const user = c.get("user");
		const allScopes = resolveQueryScopes(user, deps.registry);
		const owners = userOwners(c);
		const ownerSummaries = await aggregateOwnerCounts(
			deps.eventStore,
			allScopes,
		);
		// Auto-expand when the user has exactly one owner.
		const autoExpand =
			ownerSummaries.length === 1 ? ownerSummaries[0]?.owner : undefined;
		return c.html(
			renderDashboardPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				ownerSummaries,
				...(autoExpand === undefined ? {} : { autoExpand }),
			}),
		);
	};
	app.get("/", renderRoot);
	app.get("", renderRoot);

	// -- /dashboard/:owner -- owner page with pre-expanded repo list ------
	app.get("/:owner", async (c) => {
		const owner = c.req.param("owner");
		const user = c.get("user");
		const scopes = resolveQueryScopes(user, deps.registry, { owner });
		const owners = userOwners(c);
		const ownerSummaries = await aggregateOwnerCounts(
			deps.eventStore,
			resolveQueryScopes(user, deps.registry),
		);
		const repoSummaries = await aggregateRepoCounts(deps.eventStore, scopes);
		return c.html(
			renderDashboardPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				ownerSummaries,
				autoExpand: owner,
				...(repoSummaries.length === 1
					? { autoExpandRepo: { owner, repo: repoSummaries[0]?.repo ?? "" } }
					: {}),
				preloadedRepos: { [owner]: repoSummaries },
			}),
		);
	});

	// -- /dashboard/:owner/repos -- HTMX fragment -------------------------
	app.get("/:owner/repos", async (c) => {
		const owner = c.req.param("owner");
		const user = c.get("user");
		const scopes = resolveQueryScopes(user, deps.registry, { owner });
		const repoSummaries = await aggregateRepoCounts(deps.eventStore, scopes);
		return c.html(renderRepoList(owner, repoSummaries));
	});

	// -- /dashboard/:owner/:repo -- invocations list page ----------------
	app.get("/:owner/:repo", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const user = c.get("user");
		const rows = await fetchInvocationRows(
			deps.eventStore,
			deps.registry,
			owner,
			repo,
			limit,
		);
		const owners = userOwners(c);
		const ownerSummaries = await aggregateOwnerCounts(
			deps.eventStore,
			resolveQueryScopes(user, deps.registry),
		);
		const repoSummaries = await aggregateRepoCounts(
			deps.eventStore,
			resolveQueryScopes(user, deps.registry, { owner }),
		);
		return c.html(
			renderDashboardPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				ownerSummaries,
				autoExpand: owner,
				autoExpandRepo: { owner, repo },
				preloadedRepos: { [owner]: repoSummaries },
				preloadedInvocations: rows,
			}),
		);
	});

	// -- /dashboard/:owner/:repo/invocations -- HTMX fragment ------------
	app.get("/:owner/:repo/invocations", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const rows = await fetchInvocationRows(
			deps.eventStore,
			deps.registry,
			owner,
			repo,
			limit,
		);
		return c.html(renderInvocationList(rows));
	});

	// -- Flamegraph fragment: /dashboard/:owner/:repo/invocations/:id/flamegraph
	app.get("/:owner/:repo/invocations/:id/flamegraph", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const id = c.req.param("id");
		logger?.debug("dashboard.flamegraph.request", { id, owner, repo });
		const events = await fetchInvocationEvents(
			deps.eventStore,
			id,
			owner,
			repo,
		);
		return c.html(renderFlamegraph(events));
	});

	return {
		match: "/dashboard/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { DashboardMiddlewareDeps, OwnerSummary, RepoSummary };
export { dashboardMiddleware };
