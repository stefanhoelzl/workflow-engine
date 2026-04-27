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
import { buildSidebarData, renderSidebarBoth } from "../sidebar-tree.js";
import { renderFlamegraph } from "./flamegraph.js";
import type { InvocationRow } from "./page.js";
import { renderDashboardPage } from "./page.js";

const DEFAULT_LIMIT = 500;
// Length of the workflowSha prefix surfaced in the upload-row tooltip —
// long enough to disambiguate at a glance, short enough to read.
const SHA_SHORT_LEN = 8;

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
	owner: string;
	repo: string;
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

interface RawExceptionRow {
	id: string;
	owner: string;
	repo: string;
	workflow: string;
	name: string;
	at: string;
	ts: number | bigint;
	input: unknown;
}

interface RawSyntheticRow extends RawExceptionRow {
	kind: string;
	workflowSha: string;
	meta: unknown;
}

interface RawExhaustionRow {
	id: string;
	name: string;
	input: unknown;
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

interface TriggerKindQuery {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly trigger: string;
}

function lookupTriggerKind(
	registry: WorkflowRegistry,
	q: TriggerKindQuery,
): string | undefined {
	for (const entry of registry.list(q.owner, q.repo)) {
		if (entry.workflow.name !== q.workflow) {
			continue;
		}
		const descriptor = entry.triggers.find((t) => t.name === q.trigger);
		return descriptor?.kind;
	}
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
	const d = dispatch as {
		source?: unknown;
		user?: { login?: unknown; mail?: unknown };
	};
	if (
		d.source !== "manual" &&
		d.source !== "trigger" &&
		d.source !== "upload"
	) {
		return;
	}
	const userLogin =
		d.user && typeof d.user.login === "string" ? d.user.login : undefined;
	const userMail =
		d.user && typeof d.user.mail === "string" ? d.user.mail : undefined;
	const user = userLogin
		? {
				login: userLogin,
				...(userMail ? { mail: userMail } : {}),
			}
		: undefined;
	return {
		source: d.source,
		...(user ? { user } : {}),
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

// Fetch trigger.request + terminal rows across every `(owner, repo)` scope
// the caller has access to. An optional `triggerFilter` narrows further to
// a specific (workflow, trigger) — this is what the per-trigger filter URL
// exposes. Terminal rows are merged in memory; the page renderer applies
// the "pending-first, then newest-completed" sort.
//
// Single-leaf `trigger.exception` invocations (author-fixable pre-dispatch
// failures emitted via `executor.fail` — e.g. "imap.poll-failed") are
// fetched in parallel and merged into the result as synthetic `failed`
// rows. They have no `trigger.request` to derive the trigger name from;
// the trigger declaration name is read from `event.input.trigger` (stamped
// by `executor.fail`'s primitive). See dashboard-list-view spec
// "Single-leaf trigger.exception invocations render inline".
// biome-ignore lint/complexity/useMaxParams: orthogonal inputs already packaged by the caller
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: sequential DB fetch → merge → row shape; splitting hurts readability
async function fetchInvocationRowsForScopes(
	eventStore: EventStore,
	registry: WorkflowRegistry,
	scopes: readonly Scope[],
	limit: number,
	triggerFilter?: { workflow: string; trigger: string },
): Promise<InvocationRow[]> {
	if (scopes.length === 0) {
		return [];
	}
	const baseQuery = eventStore
		.query(scopes)
		.where("kind", "=", "trigger.request");
	const filtered = triggerFilter
		? baseQuery
				.where("workflow", "=", triggerFilter.workflow)
				.where("name", "=", triggerFilter.trigger)
		: baseQuery;
	const requests = (await filtered
		.select(["id", "owner", "repo", "workflow", "name", "at", "ts", "meta"])
		.orderBy("at", "desc")
		.orderBy("id", "desc")
		.limit(limit)
		.execute()) as RawRequestRow[];

	const ids = requests.map((r) => r.id);
	const terminals =
		ids.length === 0
			? []
			: ((await eventStore
					.query(scopes)
					.where("kind", "in", ["trigger.response", "trigger.error"])
					.where("id", "in", ids)
					.select(["id", "kind", "at", "ts", "error"])
					.execute()) as RawTerminalRow[]);

	const terminalById = new Map<string, RawTerminalRow>();
	for (const t of terminals) {
		terminalById.set(t.id, t);
	}

	const handlerRows = requests.map((r) => {
		const t = terminalById.get(r.id);
		const kind = lookupTriggerKind(registry, {
			owner: r.owner,
			repo: r.repo,
			workflow: r.workflow,
			trigger: r.name,
		});
		const dispatch = extractDispatch(r.meta);
		const row: InvocationRow = {
			id: r.id,
			owner: r.owner,
			repo: r.repo,
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

	const exceptionRows = await fetchSyntheticRows(
		eventStore,
		registry,
		scopes,
		limit,
		triggerFilter,
	);

	const merged = [...handlerRows, ...exceptionRows];
	return await attachExhaustion(eventStore, scopes, merged);
}

function extractTriggerName(rawInput: unknown): string | undefined {
	const input = parseJsonField(rawInput);
	if (!input || typeof input !== "object") {
		return;
	}
	const trigger = (input as { trigger?: unknown }).trigger;
	return typeof trigger === "string" ? trigger : undefined;
}

function summarizeIssues(rawInput: unknown): string | undefined {
	const input = parseJsonField(rawInput);
	if (!input || typeof input !== "object") {
		return;
	}
	const issues = (input as { issues?: unknown }).issues;
	if (!Array.isArray(issues) || issues.length === 0) {
		return;
	}
	const first = issues[0];
	if (!first || typeof first !== "object") {
		return;
	}
	const path = (first as { path?: unknown }).path;
	const message = (first as { message?: unknown }).message;
	const pathStr = Array.isArray(path) ? path.map(String).join(".") : "";
	if (typeof message !== "string") {
		return pathStr || undefined;
	}
	return pathStr ? `${pathStr}: ${message}` : message;
}

function buildUploadRow(r: RawSyntheticRow): InvocationRow {
	const ts = toNumber(r.ts);
	const dispatch = extractDispatch(r.meta);
	return {
		id: r.id,
		owner: r.owner,
		repo: r.repo,
		workflow: r.workflow,
		trigger: "upload",
		status: "uploaded",
		startedAt: r.at,
		completedAt: r.at,
		startedTs: ts,
		completedTs: ts,
		synthetic: true,
		syntheticKind: "system.upload",
		uploadShaShort: r.workflowSha.slice(0, SHA_SHORT_LEN),
		...(dispatch ? { dispatch } : {}),
	};
}

function buildSyntheticTriggerRow(
	r: RawSyntheticRow,
	registry: WorkflowRegistry,
	trigger: string,
): InvocationRow {
	const ts = toNumber(r.ts);
	const kind = lookupTriggerKind(registry, {
		owner: r.owner,
		repo: r.repo,
		workflow: r.workflow,
		trigger,
	});
	const syntheticKind: InvocationRow["syntheticKind"] =
		r.kind === "trigger.rejection" ? "trigger.rejection" : "trigger.exception";
	const rejectionSummary =
		syntheticKind === "trigger.rejection"
			? summarizeIssues(r.input)
			: undefined;
	return {
		id: r.id,
		owner: r.owner,
		repo: r.repo,
		workflow: r.workflow,
		trigger,
		status: "failed",
		startedAt: r.at,
		completedAt: r.at,
		startedTs: ts,
		completedTs: ts,
		synthetic: true,
		syntheticKind,
		...(kind ? { triggerKind: kind } : {}),
		...(rejectionSummary ? { rejectionSummary } : {}),
	};
}

// biome-ignore lint/complexity/useMaxParams: orthogonal inputs mirror fetchInvocationRowsForScopes
async function fetchSyntheticRows(
	eventStore: EventStore,
	registry: WorkflowRegistry,
	scopes: readonly Scope[],
	limit: number,
	triggerFilter?: { workflow: string; trigger: string },
): Promise<InvocationRow[]> {
	const base = eventStore
		.query(scopes)
		.where("kind", "in", [
			"trigger.exception",
			"trigger.rejection",
			"system.upload",
		]);
	const filtered = triggerFilter
		? base.where("workflow", "=", triggerFilter.workflow)
		: base;
	const rows = (await filtered
		.select([
			"id",
			"owner",
			"repo",
			"workflow",
			"workflowSha",
			"name",
			"kind",
			"at",
			"ts",
			"input",
			"meta",
		])
		.orderBy("at", "desc")
		.orderBy("id", "desc")
		.limit(limit)
		.execute()) as RawSyntheticRow[];

	const out: InvocationRow[] = [];
	for (const r of rows) {
		if (r.kind === "system.upload") {
			// per-trigger filter URLs do not surface upload rows.
			if (triggerFilter) {
				continue;
			}
			out.push(buildUploadRow(r));
			continue;
		}
		// trigger.exception and trigger.rejection: `input.trigger` carries
		// the trigger declaration name (stamped by the registry's
		// buildException → executor.fail primitive).
		const trigger = extractTriggerName(r.input);
		if (trigger === undefined) {
			continue;
		}
		if (triggerFilter && trigger !== triggerFilter.trigger) {
			continue;
		}
		out.push(buildSyntheticTriggerRow(r, registry, trigger));
	}
	return out;
}

function parseExhaustionInput(raw: unknown): {
	budget?: number;
	observed?: number;
} {
	const input = parseJsonField(raw);
	if (!input || typeof input !== "object") {
		return {};
	}
	const budget = (input as { budget?: unknown }).budget;
	const observed = (input as { observed?: unknown }).observed;
	const out: { budget?: number; observed?: number } = {};
	if (typeof budget === "number") {
		out.budget = budget;
	}
	if (typeof observed === "number") {
		out.observed = observed;
	}
	return out;
}

async function attachExhaustion(
	eventStore: EventStore,
	scopes: readonly Scope[],
	rows: InvocationRow[],
): Promise<InvocationRow[]> {
	const failedIds = rows.filter((r) => r.status === "failed").map((r) => r.id);
	if (failedIds.length === 0) {
		return rows;
	}
	const exhRows = (await eventStore
		.query(scopes)
		.where("kind", "=", "system.exhaustion")
		.where("id", "in", failedIds)
		.select(["id", "name", "input"])
		.execute()) as RawExhaustionRow[];
	if (exhRows.length === 0) {
		return rows;
	}
	const byId = new Map<string, RawExhaustionRow>();
	for (const e of exhRows) {
		byId.set(e.id, e);
	}
	return rows.map((r) => {
		const e = byId.get(r.id);
		if (!e) {
			return r;
		}
		const dim = e.name as NonNullable<InvocationRow["exhaustion"]>["dim"];
		const exhaustion: InvocationRow["exhaustion"] = {
			dim,
			...parseExhaustionInput(e.input),
		};
		return { ...r, exhaustion };
	});
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires three list routes + flamegraph fragment + shared scope/sidebar helpers; splitting fragments the request pipeline
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

	function buildSidebarTree(
		owners: readonly string[],
		active: {
			owner?: string;
			repo?: string;
			workflow?: string;
			trigger?: string;
		},
	) {
		const data = buildSidebarData(deps.registry, owners);
		return renderSidebarBoth(data, {
			surface: "/dashboard",
			...(active.owner ? { owner: active.owner } : {}),
			...(active.repo ? { repo: active.repo } : {}),
			...(active.workflow ? { workflow: active.workflow } : {}),
			...(active.trigger ? { trigger: active.trigger } : {}),
		});
	}

	interface Filter {
		readonly owner: string;
		readonly repo?: string;
		readonly workflow?: string;
		readonly trigger?: string;
	}

	async function renderListFiltered(c: Context, filter?: Filter) {
		const user = c.get("user");
		const owners = userOwners(c);
		const scopes = resolveQueryScopes(
			user,
			deps.registry,
			filter
				? { owner: filter.owner, ...(filter.repo ? { repo: filter.repo } : {}) }
				: undefined,
		);
		const rows = await fetchInvocationRowsForScopes(
			deps.eventStore,
			deps.registry,
			scopes,
			limit,
			filter?.workflow && filter?.trigger
				? { workflow: filter.workflow, trigger: filter.trigger }
				: undefined,
		);
		return c.html(
			renderDashboardPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				rows,
				...(filter ? { filter } : {}),
				sidebarTree: buildSidebarTree(owners, filter ?? {}),
			}),
		);
	}

	// -- Root: /dashboard -- all scopes the user has access to ------------
	const renderRoot = (c: Context) => renderListFiltered(c);
	app.get("/", renderRoot);
	app.get("", renderRoot);

	// -- /dashboard/:owner -- scoped to owner -----------------------------
	app.get("/:owner", (c) =>
		renderListFiltered(c, { owner: c.req.param("owner") }),
	);

	// -- /dashboard/:owner/:repo -- scoped to (owner, repo) --------------
	app.get("/:owner/:repo", (c) =>
		renderListFiltered(c, {
			owner: c.req.param("owner"),
			repo: c.req.param("repo"),
		}),
	);

	// -- /dashboard/:owner/:repo/:workflow/:trigger -- filter to one trigger
	app.get("/:owner/:repo/:workflow/:trigger", (c) =>
		renderListFiltered(c, {
			owner: c.req.param("owner"),
			repo: c.req.param("repo"),
			workflow: c.req.param("workflow"),
			trigger: c.req.param("trigger"),
		}),
	);

	// -- Flamegraph fragment ---------------------------------------------
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

export type { DashboardMiddlewareDeps };
export { dashboardMiddleware };
