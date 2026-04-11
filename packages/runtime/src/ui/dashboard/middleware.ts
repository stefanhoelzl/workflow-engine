import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import type { EventStore } from "../../event-bus/event-store.js";
import type { Middleware } from "../../triggers/http.js";
import {
	type AggregateState,
	getAllEventTypes,
	getDistinctEventTypes,
	getHeaderStats,
	getTimeline,
	listCorrelations,
} from "./queries.js";
import { renderPage } from "./page.js";
import {
	renderEntryList,
	renderEventTypeCheckboxes,
	renderHeaderStats,
	renderTypeFilter,
} from "./list.js";
import { renderTimeline } from "./timeline.js";

const require = createRequire(import.meta.url);
const alpineJs = readFileSync(
	require.resolve("alpinejs/dist/cdn.min.js"),
	"utf-8",
);
const htmxJs = readFileSync(
	require.resolve("htmx.org/dist/htmx.min.js"),
	"utf-8",
);

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const VALID_STATES = new Set(["pending", "failed", "done"]);

async function handleListFragment(
	eventStore: EventStore,
	fragment: string,
	type: string | undefined,
	eventTypesParam: string | undefined,
): Promise<string | null> {
	if (fragment === "stats") {
		return renderHeaderStats(await getHeaderStats(eventStore));
	}
	if (fragment === "triggerTypes") {
		return renderTypeFilter(
			await getDistinctEventTypes(eventStore),
			type ?? "",
		);
	}
	if (fragment === "eventTypes") {
		return renderEventTypeCheckboxes(
			await getAllEventTypes(eventStore),
			eventTypesParam ? eventTypesParam.split(",") : [],
		);
	}
	return null;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: route registration reads better in one place
function dashboardMiddleware(eventStore: EventStore): Middleware {
	const app = new Hono().basePath("/dashboard");

	app.get("/", (c) => c.html(renderPage()));

	app.get(
		"/list",
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: route handler with query param branching
		async (c) => {
			const state = c.req.query("state");
			const type = c.req.query("type");
			const eventTypesParam = c.req.query("eventTypes");
			const cursor = c.req.query("cursor");
			const fragment = c.req.query("fragment");

			if (fragment) {
				const html = await handleListFragment(
					eventStore,
					fragment,
					type,
					eventTypesParam,
				);
				if (html !== null) {
					return c.html(html);
				}
			}

			const eventTypes = eventTypesParam
				? eventTypesParam.split(",").filter(Boolean)
				: undefined;

			const result = await listCorrelations(eventStore, {
				state:
					state && VALID_STATES.has(state)
						? (state as AggregateState)
						: undefined,
				type: type || undefined,
				eventTypes:
					eventTypes && eventTypes.length > 0 ? eventTypes : undefined,
				cursor: cursor || undefined,
			});

			const params = new URLSearchParams();
			if (state) {
				params.set("state", state);
			}
			if (type) {
				params.set("type", type);
			}
			if (eventTypesParam) {
				params.set("eventTypes", eventTypesParam);
			}

			return c.html(renderEntryList(result.items, result.nextCursor, params));
		},
	);

	app.get("/timeline/:correlationId", async (c) => {
		const correlationId = c.req.param("correlationId");
		const events = await getTimeline(eventStore, correlationId);
		return c.html(renderTimeline(events));
	});

	app.get("/alpine.js", (c) =>
		c.body(alpineJs, {
			headers: {
				"content-type": "application/javascript",
				"cache-control": IMMUTABLE_CACHE,
			},
		}),
	);

	app.get("/htmx.js", (c) =>
		c.body(htmxJs, {
			headers: {
				"content-type": "application/javascript",
				"cache-control": IMMUTABLE_CACHE,
			},
		}),
	);

	return {
		match: "/dashboard/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export { dashboardMiddleware };
