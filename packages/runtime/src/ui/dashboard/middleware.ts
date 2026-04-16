import type { Context } from "hono";
import { Hono } from "hono";
import type { EventStore } from "../../event-bus/event-store.js";
import type { Middleware } from "../../triggers/http.js";
import { renderDashboardPage } from "./page.js";

const DEFAULT_LIMIT = 100;

interface DashboardMiddlewareDeps {
	readonly eventStore: EventStore;
	readonly limit?: number;
}

function dashboardMiddleware(deps: DashboardMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/dashboard");
	const limit = deps.limit ?? DEFAULT_LIMIT;

	const render = async (c: Context) => {
		const rows = await deps.eventStore.query
			.select([
				"id",
				"workflow",
				"trigger",
				"status",
				"startedAt",
				"completedAt",
			])
			.orderBy("startedAt", "desc")
			.limit(limit)
			.execute();
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
