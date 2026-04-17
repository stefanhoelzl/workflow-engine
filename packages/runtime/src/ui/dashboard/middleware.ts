import type { Context } from "hono";
import { Hono } from "hono";
import type { EventStore } from "../../event-bus/event-store.js";
import type { Middleware } from "../../triggers/http.js";
import type { InvocationRow } from "./page.js";
import { renderDashboardPage, renderInvocationList } from "./page.js";

const DEFAULT_LIMIT = 100;

interface DashboardMiddlewareDeps {
	readonly eventStore: EventStore;
	readonly limit?: number;
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
	const user = c.req.header("X-Auth-Request-User") ?? "";
	const email = c.req.header("X-Auth-Request-Email") ?? "";
	return c.html(renderDashboardPage(user, email));
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

function dashboardMiddleware(deps: DashboardMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/dashboard");
	const limit = deps.limit ?? DEFAULT_LIMIT;

	app.get("/", renderShell);
	app.get("", renderShell);
	app.get("/invocations", async (c) => {
		const rows = await fetchInvocationRows(deps.eventStore, limit);
		return c.html(renderInvocationList(rows));
	});

	return {
		match: "/dashboard/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { DashboardMiddlewareDeps };
export { dashboardMiddleware };
