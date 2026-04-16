import type { Context } from "hono";
import { Hono } from "hono";
import type { EventStore } from "../../event-bus/event-store.js";
import type { Middleware } from "../../triggers/http.js";
import type { InvocationRow } from "./page.js";
import { renderDashboardPage } from "./page.js";

const DEFAULT_LIMIT = 100;

interface DashboardMiddlewareDeps {
	readonly eventStore: EventStore;
	readonly limit?: number;
}

interface RawRequestRow {
	id: string;
	workflow: string;
	name: string;
	ts: string;
}

interface RawTerminalRow {
	id: string;
	kind: string;
	ts: string;
	error: unknown;
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

function dashboardMiddleware(deps: DashboardMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/dashboard");
	const limit = deps.limit ?? DEFAULT_LIMIT;

	const render = async (c: Context) => {
		// 1. Fetch trigger.request events (one per invocation, ordered by ts desc)
		const requests = (await deps.eventStore.query
			.where("kind", "=", "trigger.request")
			.select(["id", "workflow", "name", "ts"])
			.orderBy("ts", "desc")
			.limit(limit)
			.execute()) as RawRequestRow[];

		// 2. Fetch matching terminal events for those ids
		const ids = requests.map((r) => r.id);
		const terminals =
			ids.length === 0
				? []
				: ((await deps.eventStore.query
						.where("kind", "in", ["trigger.response", "trigger.error"])
						.where("id", "in", ids)
						.select(["id", "kind", "ts", "error"])
						.execute()) as RawTerminalRow[]);

		const terminalById = new Map<string, RawTerminalRow>();
		for (const t of terminals) {
			terminalById.set(t.id, t);
		}

		const rows: InvocationRow[] = requests.map((r) => {
			const t = terminalById.get(r.id);
			return {
				id: r.id,
				workflow: r.workflow,
				trigger: r.name,
				status: statusFromTerminal(t?.kind),
				startedAt: r.ts,
				completedAt: t?.ts ?? null,
			};
		});

		const user = c.req.header("X-Auth-Request-User") ?? "";
		const email = c.req.header("X-Auth-Request-Email") ?? "";
		return c.html(renderDashboardPage(rows, user, email));
	};
	app.get("/", render);
	app.get("", render);

	return {
		match: "/dashboard/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { DashboardMiddlewareDeps };
export { dashboardMiddleware };
