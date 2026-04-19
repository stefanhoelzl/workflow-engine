import type { InvocationEvent } from "@workflow-engine/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { headerUserMiddleware } from "../../auth/header-user.js";
import { tenantSet, validateTenant } from "../../auth/tenant.js";
import type { EventStore } from "../../event-bus/event-store.js";
import type { Logger } from "../../logger.js";
import type { Middleware } from "../../triggers/http.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { renderFlamegraph } from "./flamegraph.js";
import type { InvocationRow } from "./page.js";
import { renderDashboardPage, renderInvocationList } from "./page.js";

const DEFAULT_LIMIT = 100;

interface DashboardMiddlewareDeps {
	readonly eventStore: EventStore;
	readonly registry: WorkflowRegistry;
	readonly limit?: number;
	readonly logger?: Logger;
}

interface RawRequestRow {
	id: string;
	workflow: string;
	name: string;
	at: string;
	ts: number | bigint;
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

function sortedTenants(c: Context, registry: WorkflowRegistry): string[] {
	const user = c.get("user");
	if (user) {
		return Array.from(tenantSet(user)).sort();
	}
	// Dev/unauthenticated fallback: show all tenants the runtime knows about.
	// In production, oauth2-proxy forward-auth ensures a user is always set on
	// `/dashboard/*`; arriving without one means auth is disabled (open mode).
	const fromRegistry = new Set<string>();
	for (const tenant of registry.tenants()) {
		if (validateTenant(tenant)) {
			fromRegistry.add(tenant);
		}
	}
	return Array.from(fromRegistry).sort();
}

function resolveActiveTenant(
	c: Context,
	tenants: string[],
): string | undefined {
	if (tenants.length === 0) {
		return;
	}
	const requested = c.req.query("tenant");
	if (requested && tenants.includes(requested)) {
		return requested;
	}
	return tenants[0];
}

function lookupTriggerKind(
	registry: WorkflowRegistry,
	tenant: string,
	workflow: string,
	triggerName: string,
): string | undefined {
	for (const entry of registry.list(tenant)) {
		if (entry.workflow.name !== workflow) {
			continue;
		}
		const descriptor = entry.triggers.find((t) => t.name === triggerName);
		return descriptor?.kind;
	}
}

async function fetchInvocationRows(
	eventStore: EventStore,
	registry: WorkflowRegistry,
	tenant: string,
	limit: number,
): Promise<InvocationRow[]> {
	const requests = (await eventStore
		.query(tenant)
		.where("kind", "=", "trigger.request")
		.select(["id", "workflow", "name", "at", "ts"])
		.orderBy("at", "desc")
		.orderBy("id", "desc")
		.limit(limit)
		.execute()) as RawRequestRow[];

	const ids = requests.map((r) => r.id);
	const terminals =
		ids.length === 0
			? []
			: ((await eventStore
					.query(tenant)
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
		const kind = lookupTriggerKind(registry, tenant, r.workflow, r.name);
		const row: InvocationRow = {
			id: r.id,
			workflow: r.workflow,
			trigger: r.name,
			status: statusFromTerminal(t?.kind),
			startedAt: r.at,
			completedAt: t?.at ?? null,
			startedTs: toNumber(r.ts),
			completedTs: t ? toNumber(t.ts) : null,
			...(kind ? { triggerKind: kind } : {}),
		};
		return row;
	});
}

async function fetchInvocationEvents(
	eventStore: EventStore,
	id: string,
	tenant: string,
): Promise<InvocationEvent[]> {
	const rows = (await eventStore
		.query(tenant)
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
		tenant: row.tenant as string,
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
	return {
		...base,
		...(input === undefined ? {} : { input }),
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
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

function dashboardMiddleware(deps: DashboardMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/dashboard");
	app.use("*", headerUserMiddleware());
	const limit = deps.limit ?? DEFAULT_LIMIT;
	const logger = deps.logger;

	const renderShell = (c: Context) => {
		const user = c.get("user");
		const tenants = sortedTenants(c, deps.registry);
		const activeTenant = resolveActiveTenant(c, tenants);
		return c.html(
			renderDashboardPage({
				user: user?.name ?? "",
				email: user?.mail ?? "",
				tenants,
				activeTenant,
			}),
		);
	};

	app.get("/", renderShell);
	app.get("", renderShell);
	app.get("/invocations", async (c) => {
		const tenants = sortedTenants(c, deps.registry);
		const activeTenant = resolveActiveTenant(c, tenants);
		if (!activeTenant) {
			return c.html(renderInvocationList([]));
		}
		const rows = await fetchInvocationRows(
			deps.eventStore,
			deps.registry,
			activeTenant,
			limit,
		);
		return c.html(renderInvocationList(rows));
	});
	app.get("/invocations/:id/flamegraph", async (c) => {
		const id = c.req.param("id");
		const tenants = sortedTenants(c, deps.registry);
		const activeTenant = resolveActiveTenant(c, tenants);
		logger?.debug("dashboard.flamegraph.request", { id, tenant: activeTenant });
		if (!activeTenant) {
			return c.html(renderFlamegraph([]));
		}
		const events = await fetchInvocationEvents(
			deps.eventStore,
			id,
			activeTenant,
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
