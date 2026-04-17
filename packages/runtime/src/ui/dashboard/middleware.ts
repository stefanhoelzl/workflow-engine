import type { InvocationEvent } from "@workflow-engine/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { userMiddleware } from "../../auth/user.js";
import type { EventStore } from "../../event-bus/event-store.js";
import type { Logger } from "../../logger.js";
import type { Middleware } from "../../triggers/http.js";
import { renderFlamegraph } from "./flamegraph.js";
import type { InvocationRow } from "./page.js";
import { renderDashboardPage, renderInvocationList } from "./page.js";

const DEFAULT_LIMIT = 100;

interface DashboardMiddlewareDeps {
	readonly eventStore: EventStore;
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

function renderShell(c: Context) {
	const user = c.get("user");
	return c.html(renderDashboardPage(user?.name ?? "", user?.mail ?? ""));
}

async function fetchInvocationRows(
	eventStore: EventStore,
	limit: number,
): Promise<InvocationRow[]> {
	const requests = (await eventStore.query
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
			: ((await eventStore.query
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
		return {
			id: r.id,
			workflow: r.workflow,
			trigger: r.name,
			status: statusFromTerminal(t?.kind),
			startedAt: r.at,
			completedAt: t?.at ?? null,
			startedTs: toNumber(r.ts),
			completedTs: t ? toNumber(t.ts) : null,
		};
	});
}

async function fetchInvocationEvents(
	eventStore: EventStore,
	id: string,
): Promise<InvocationEvent[]> {
	const rows = (await eventStore.query
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
	app.use("*", userMiddleware());
	const limit = deps.limit ?? DEFAULT_LIMIT;
	const logger = deps.logger;

	app.get("/", renderShell);
	app.get("", renderShell);
	app.get("/invocations", async (c) => {
		const rows = await fetchInvocationRows(deps.eventStore, limit);
		return c.html(renderInvocationList(rows));
	});
	app.get("/invocations/:id/flamegraph", async (c) => {
		const id = c.req.param("id");
		logger?.debug("dashboard.flamegraph.request", { id });
		const events = await fetchInvocationEvents(deps.eventStore, id);
		return c.html(renderFlamegraph(events));
	});

	return {
		match: "/dashboard/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { DashboardMiddlewareDeps };
export { dashboardMiddleware };
