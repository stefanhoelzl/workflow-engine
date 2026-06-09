import type { InvocationEvent } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { ownerSet } from "../../auth/owner.js";
import { requireOwnerMember } from "../../auth/owner-mw.js";
import { resolveQueryScopes } from "../../auth/scopes.js";
import type { EventStore, Scope } from "../../event-store.js";
import type { Logger } from "../../logger.js";
import { createNotFoundHandler } from "../../services/content-negotiation.js";
import type { Middleware } from "../../triggers/http.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { buildSidebarData, SidebarTree } from "../sidebar-tree.js";
import { Tabs } from "../tabs.js";
import { renderEventDetail } from "./event-detail.js";
import { renderFlamegraph } from "./flamegraph.js";
import type { InvocationRow } from "./page.js";
import { renderInvocationsPage } from "./page.js";
import {
	queryTriggerPairs,
	REMOVED_KIND,
	workflowHistoryExists,
} from "./removed-triggers.js";

const DEFAULT_LIMIT = 500;

interface InvocationsMiddlewareDeps {
	readonly eventStore: EventStore;
	readonly registry: WorkflowRegistry;
	readonly limit?: number;
	readonly logger?: Logger;
	// Session middleware mounted before the invocations handlers. Required
	// per `auth/spec.md` "sessionMw mount points": every route under
	// `/invocations/*` SHALL enforce session auth. Tests that do not
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
	error: unknown;
}

interface RawSyntheticRow extends RawExceptionRow {
	kind: string;
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
// the caller has access to. An optional `narrow` narrows further to
// a specific (workflow, trigger) — this is what the per-trigger filter URL
// exposes. Terminal rows are merged in memory; the page renderer applies
// the "pending-first, then newest-started" sort.
//
// Single-leaf `trigger.exception` invocations (author-fixable pre-dispatch
// failures emitted via `executor.fail` — e.g. "imap.poll-failed") are
// fetched in parallel and merged into the result as synthetic `failed`
// rows. They have no `trigger.request` to derive the trigger name from;
// the trigger declaration name is read from `event.input.trigger` (stamped
// by `executor.fail`'s primitive). See invocations-list-view spec
// "Single-leaf trigger.exception invocations render inline".
// biome-ignore lint/complexity/useMaxParams: orthogonal inputs already packaged by the caller
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: sequential DB fetch → merge → row shape; splitting hurts readability
async function fetchInvocationRowsForScopes(
	eventStore: EventStore,
	registry: WorkflowRegistry,
	scopes: readonly Scope[],
	limit: number,
	narrow?: { workflow: string; trigger?: string },
): Promise<InvocationRow[]> {
	if (scopes.length === 0) {
		return [];
	}
	const baseQuery = eventStore
		.query(scopes)
		.where("kind", "=", "trigger.request");
	let filtered = baseQuery;
	if (narrow) {
		filtered = filtered.where("workflow", "=", narrow.workflow);
		if (narrow.trigger) {
			filtered = filtered.where("name", "=", narrow.trigger);
		}
	}
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
		// No live kind ⇒ the (workflow, trigger) pair is gone from the registry
		// (removed/renamed). Promote the already-computed undefined into the
		// `removed` sentinel + flag — no extra query. See removed triggers.ts.
		const isRemoved = kind === undefined;
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
			triggerKind: kind ?? REMOVED_KIND,
			...(isRemoved ? { removed: true } : {}),
			...(dispatch ? { dispatch } : {}),
		};
		return row;
	});

	const exceptionRows = await fetchSyntheticRows(
		eventStore,
		registry,
		scopes,
		limit,
		narrow,
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
		triggerKind: "upload",
		synthetic: true,
		syntheticKind: "system.upload",
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
	// trigger.exception rows are non-expandable in the list, so the
	// failure detail (cause + optional stage + optional error message)
	// surfaces only as a hover tooltip on the row's "trigger setup
	// failed" pill. Compose the same string that the legacy
	// flame-fragment--exception view used to render so authors recognise
	// it from the in-fragment view they may have seen previously.
	const setupFailureMessage =
		syntheticKind === "trigger.exception"
			? composeSetupFailureMessage(r)
			: undefined;
	const isRemoved = kind === undefined;
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
		triggerKind: kind ?? REMOVED_KIND,
		...(isRemoved ? { removed: true } : {}),
		...(rejectionSummary ? { rejectionSummary } : {}),
		...(setupFailureMessage ? { setupFailureMessage } : {}),
	};
}

function composeSetupFailureMessage(r: RawSyntheticRow): string {
	const cause = r.name;
	const input = parseJsonField(r.input);
	const stage =
		input &&
		typeof input === "object" &&
		typeof (input as { stage?: unknown }).stage === "string"
			? ((input as { stage: string }).stage as string)
			: "";
	const errorObj = parseJsonField(r.error);
	const message =
		errorObj &&
		typeof errorObj === "object" &&
		typeof (errorObj as { message?: unknown }).message === "string"
			? ((errorObj as { message: string }).message as string)
			: "";
	const stageSuffix = stage ? ` (${stage})` : "";
	const messageSuffix = message ? `: ${message}` : "";
	return `${cause}${stageSuffix}${messageSuffix}`;
}

// biome-ignore lint/complexity/useMaxParams: orthogonal inputs mirror fetchInvocationRowsForScopes
async function fetchSyntheticRows(
	eventStore: EventStore,
	registry: WorkflowRegistry,
	scopes: readonly Scope[],
	limit: number,
	narrow?: { workflow: string; trigger?: string },
): Promise<InvocationRow[]> {
	const base = eventStore
		.query(scopes)
		.where("kind", "in", [
			"trigger.exception",
			"trigger.rejection",
			"system.upload",
		]);
	const filtered = narrow ? base.where("workflow", "=", narrow.workflow) : base;
	const rows = (await filtered
		.select([
			"id",
			"owner",
			"repo",
			"workflow",
			"name",
			"kind",
			"at",
			"ts",
			"input",
			"meta",
			"error",
		])
		.orderBy("at", "desc")
		.orderBy("id", "desc")
		.limit(limit)
		.execute()) as RawSyntheticRow[];

	const out: InvocationRow[] = [];
	for (const r of rows) {
		if (r.kind === "system.upload") {
			// per-trigger filter URLs do not surface upload rows; workflow-level
			// and broader scopes do.
			if (narrow?.trigger) {
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
		if (narrow?.trigger && trigger !== narrow.trigger) {
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

const SYNTHETIC_LEAF_KINDS = new Set([
	"trigger.exception",
	"trigger.rejection",
	"system.upload",
]);

const INSPECTABLE_LEAF_KINDS = new Set(["trigger.rejection", "system.upload"]);

function isSyntheticLeaf(events: readonly InvocationEvent[]): boolean {
	const [first] = events;
	return (
		events.length === 1 &&
		first !== undefined &&
		SYNTHETIC_LEAF_KINDS.has(first.kind)
	);
}

function isInspectableLeaf(events: readonly InvocationEvent[]): boolean {
	const [first] = events;
	return (
		events.length === 1 &&
		first !== undefined &&
		INSPECTABLE_LEAF_KINDS.has(first.kind)
	);
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
function invocationsMiddleware(deps: InvocationsMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/invocations");
	app.use("*", deps.sessionMw);
	// Guard every sub-route that names an :owner (with optional :repo). The
	// root /invocations is intentionally unguarded: it just renders the shell
	// scoped to the user's owner allow-set.
	app.use("/:owner/*", requireOwnerMember());
	app.use("/:owner", requireOwnerMember());
	app.use("/:owner/:repo/*", requireOwnerMember());
	app.use("/:owner/:repo", requireOwnerMember());
	app.notFound(createNotFoundHandler());
	const limit = deps.limit ?? DEFAULT_LIMIT;
	const logger = deps.logger;

	async function buildSidebarTree(
		user: Parameters<typeof resolveQueryScopes>[0],
		owners: readonly string[],
		active: {
			owner?: string;
			repo?: string;
			workflow?: string;
			trigger?: string;
		},
	) {
		// Removed nodes are an invocations-surface concept only. The pair set
		// is GLOBAL (every scope the user can access), not narrowed by the URL
		// filter, so the tree stays complete as the user drills in. One distinct
		// query, deduped tuples — see removed triggers.ts.
		const globalScopes = resolveQueryScopes(user, deps.registry);
		const triggerPairs =
			globalScopes.length > 0
				? await queryTriggerPairs(deps.eventStore, globalScopes)
				: [];
		const data = buildSidebarData(deps.registry, owners, triggerPairs);
		return (
			<SidebarTree
				surface="/invocations"
				data={data}
				active={{
					...(active.owner ? { owner: active.owner } : {}),
					...(active.repo ? { repo: active.repo } : {}),
					...(active.workflow ? { workflow: active.workflow } : {}),
					...(active.trigger ? { trigger: active.trigger } : {}),
				}}
			/>
		);
	}

	interface Filter {
		readonly owner: string;
		readonly repo?: string;
		readonly workflow?: string;
		readonly trigger?: string;
	}

	// Validate the :workflow segment. A workflow "exists" if it is in the
	// registry OR has any invocation history in the EventStore — so removed
	// and renamed workflows stay navigable by URL; only a workflow in NEITHER
	// is a 404 (the enumeration-prevention shape). The :trigger segment is
	// intentionally NOT separately validated (it never was): a trigger name
	// just narrows the EventStore query, rendering an empty list when nothing
	// matches. Validating it on the `name` column would wrongly 404
	// trigger.exception / trigger.rejection history, which stamps the trigger
	// name into `input.trigger`, not `name`. Membership is enforced upstream,
	// so the history widening confirms nothing beyond what the member owns.
	async function workflowSegmentMissing(filter: Filter): Promise<boolean> {
		if (!(filter.workflow && filter.repo)) {
			return false;
		}
		const entries = deps.registry.list(filter.owner, filter.repo);
		if (entries.some((e) => e.workflow.name === filter.workflow)) {
			return false;
		}
		return !(await workflowHistoryExists(
			deps.eventStore,
			filter.owner,
			filter.repo,
			filter.workflow,
		));
	}

	// True when the filter's workflow (or trigger) is no longer registry-backed
	// — i.e. an removed scope reachable only via invocation history. The
	// `/trigger` and `/queue` surfaces are registry-only, so their in-page tabs
	// are suppressed for such scopes (they would 404). Synchronous, registry-only.
	function isScopeRemoved(filter: Filter): boolean {
		if (!(filter.workflow && filter.repo)) {
			return false;
		}
		const entry = deps.registry
			.list(filter.owner, filter.repo)
			.find((e) => e.workflow.name === filter.workflow);
		if (!entry) {
			return true; // workflow absent from the registry
		}
		return filter.trigger
			? !entry.triggers.some((t) => t.name === filter.trigger)
			: false;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shared 5-level filter handler — owner/repo/workflow/trigger validation, scope narrow, sidebar+tabs build; splitting fragments the request flow
	async function renderListFiltered(c: Context, filter?: Filter) {
		const user = c.get("user");
		const owners = userOwners(c);

		if (filter && (await workflowSegmentMissing(filter))) {
			return c.notFound();
		}

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
			filter?.workflow
				? {
						workflow: filter.workflow,
						...(filter.trigger ? { trigger: filter.trigger } : {}),
					}
				: undefined,
		);
		const path = filter
			? `/${[filter.owner, filter.repo, filter.workflow, filter.trigger]
					.filter((s): s is string => Boolean(s))
					.join("/")}`
			: "";
		const sidebarTree = await buildSidebarTree(user, owners, filter ?? {});
		return c.html(
			renderInvocationsPage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				owners,
				rows,
				sidebarTree,
				tabs: (
					<Tabs
						surface="/invocations"
						path={path}
						scope={filter ?? {}}
						removed={filter ? isScopeRemoved(filter) : false}
					/>
				),
			}),
		);
	}

	// -- Root: /invocations -- all scopes the user has access to ------------
	const renderRoot = (c: Context) => renderListFiltered(c);
	app.get("/", renderRoot);
	app.get("", renderRoot);

	// -- /invocations/:owner -- scoped to owner -----------------------------
	app.get("/:owner", (c) =>
		renderListFiltered(c, { owner: c.req.param("owner") }),
	);

	// -- /invocations/:owner/:repo -- scoped to (owner, repo) --------------
	app.get("/:owner/:repo", (c) =>
		renderListFiltered(c, {
			owner: c.req.param("owner"),
			repo: c.req.param("repo"),
		}),
	);

	// -- /invocations/:owner/:repo/:workflow -- filter to one workflow ------
	app.get("/:owner/:repo/:workflow", (c) =>
		renderListFiltered(c, {
			owner: c.req.param("owner"),
			repo: c.req.param("repo"),
			workflow: c.req.param("workflow"),
		}),
	);

	// -- Flamegraph fragment ---------------------------------------------
	// Registered before the 4-segment trigger filter so Hono's matcher
	// resolves `/<owner>/<repo>/<id>/flamegraph` to this literal-tail route
	// rather than to `/:owner/:repo/:workflow/:trigger`.
	app.get("/:owner/:repo/:id/flamegraph", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const id = c.req.param("id");
		logger?.debug("invocations.flamegraph.request", { id, owner, repo });
		const events = await fetchInvocationEvents(
			deps.eventStore,
			id,
			owner,
			repo,
		);
		if (events.length === 0 || isSyntheticLeaf(events)) {
			return c.notFound();
		}
		// Resolve trigger kind so the trigger bar gets the same icon the
		// sidebar uses for that kind. Workflow + trigger name come from the
		// trigger.request event; the registry lookup is best-effort —
		// missing kind falls back to the generic zap.
		const triggerReq = events.find((e) => e.kind === "trigger.request");
		const triggerKind = triggerReq
			? lookupTriggerKind(deps.registry, {
					owner: triggerReq.owner,
					repo: triggerReq.repo,
					workflow: triggerReq.workflow,
					trigger: triggerReq.name,
				})
			: undefined;
		return c.html(renderFlamegraph(events, triggerKind));
	});

	// -- Event-detail fragment -------------------------------------------
	// Registered before the 4-segment trigger filter for the same reason as
	// the flamegraph route. Restricted to single-leaf rows of kind
	// `trigger.rejection` or `system.upload`; every other case (real paired
	// row, `trigger.exception`, unknown id, non-member) responds 404 with
	// the same shape — no enumeration distinction (see
	// `invocations-list-view/spec.md` "Event-detail fragment endpoint").
	app.get("/:owner/:repo/:id/event", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const id = c.req.param("id");
		logger?.debug("invocations.event.request", { id, owner, repo });
		const events = await fetchInvocationEvents(
			deps.eventStore,
			id,
			owner,
			repo,
		);
		const [leaf] = events;
		if (leaf === undefined || !isInspectableLeaf(events)) {
			return c.notFound();
		}
		return c.html(renderEventDetail(leaf));
	});

	// -- /invocations/:owner/:repo/:workflow/:trigger -- filter to one trigger
	app.get("/:owner/:repo/:workflow/:trigger", (c) =>
		renderListFiltered(c, {
			owner: c.req.param("owner"),
			repo: c.req.param("repo"),
			workflow: c.req.param("workflow"),
			trigger: c.req.param("trigger"),
		}),
	);

	return {
		match: "/invocations/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { InvocationsMiddlewareDeps };
export { invocationsMiddleware };
