import type { EventStore } from "../event-bus/event-store.js";
import { sql } from "../event-bus/event-store.js";

type AggregateState = "pending" | "failed" | "done";

interface CorrelationSummary {
	correlationId: string;
	aggregateState: AggregateState;
	initialEventType: string;
	eventCount: number;
	lastEventAt: string;
}

interface CorrelationListOptions {
	state?: AggregateState | undefined;
	type?: string | undefined;
	eventTypes?: string[] | undefined;
	cursor?: string | undefined;
	limit?: number | undefined;
}

interface CorrelationListResult {
	items: CorrelationSummary[];
	nextCursor: string | null;
}

interface TimelineEvent {
	id: string;
	type: string;
	state: string;
	result: string | null;
	correlationId: string;
	parentEventId: string | null;
	targetAction: string | null;
	payload: unknown;
	error: unknown;
	createdAt: string;
	emittedAt: string;
	startedAt: string | null;
	doneAt: string | null;
}

interface HeaderStats {
	pending: number;
	failed: number;
	done: number;
}

const DEFAULT_PAGE_SIZE = 50;

// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE callback types are deeply generic
const LATEST_STATE_CTE = (events: any) =>
	events.selectAll().select(
		sql`ROW_NUMBER() OVER (PARTITION BY id ORDER BY CASE state
			WHEN 'done' THEN 3
			WHEN 'processing' THEN 2
			WHEN 'pending' THEN 1
			ELSE 0
		END DESC, rowid DESC)`.as("rn"),
	);

// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE callback types are deeply generic
const CURRENT_EVENTS_CTE = (latest: any) =>
	latest.selectAll().where("rn", "=", 1);

// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE callback types are deeply generic
const SUMMARIES_CTE = (currentEvents: any) =>
	currentEvents
		.select(["correlationId"])
		.select(
			sql<string>`CASE
			WHEN COUNT(*) FILTER (WHERE state IN ('pending', 'processing')) > 0 THEN 'pending'
			WHEN COUNT(*) FILTER (WHERE result = 'failed') > 0 THEN 'failed'
			ELSE 'done'
		END`.as("aggregateState"),
		)
		.select(
			sql<string>`MIN(CASE WHEN "parentEventId" IS NULL THEN type END)`.as(
				"initialEventType",
			),
		)
		.select(sql<number>`COUNT(DISTINCT id)`.as("eventCount"))
		.select(sql<string>`MAX("emittedAt")`.as("lastEventAt"))
		.groupBy("correlationId");

function applyFilters(
	baseQuery: ReturnType<EventStore["with"]>,
	options: CorrelationListOptions,
) {
	let query = baseQuery.where(sql`1`, "=", 1);
	if (options.state) {
		query = query.where("aggregateState", "=", options.state);
	}
	if (options.type) {
		query = query.where("initialEventType", "=", options.type);
	}
	if (options.eventTypes && options.eventTypes.length > 0) {
		const types = options.eventTypes.map((t) => sql`${t}`);
		query = query.where(
			sql`"correlationId" IN (SELECT DISTINCT "correlationId" FROM current_events WHERE type IN (${sql.join(types)}))`,
			"=",
			sql`true`,
		);
	}
	return query;
}

async function listCorrelations(
	eventStore: EventStore,
	options: CorrelationListOptions = {},
): Promise<CorrelationListResult> {
	const limit = options.limit ?? DEFAULT_PAGE_SIZE;
	const offset = options.cursor ? Number(options.cursor) : 0;

	const baseQuery = eventStore
		.with("latest", LATEST_STATE_CTE)
		.with("current_events", CURRENT_EVENTS_CTE)
		.with("summaries", SUMMARIES_CTE);

	const rows = await applyFilters(baseQuery, options)
		.selectAll()
		.orderBy(sql`("aggregateState" = 'pending') DESC`)
		.orderBy("lastEventAt", "desc")
		.limit(limit + 1)
		.offset(offset)
		.execute();

	const hasMore = rows.length > limit;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE query results are untyped
	const items = rows.slice(0, limit).map((row: any) => ({
		correlationId: row.correlationId as string,
		aggregateState: row.aggregateState as AggregateState,
		initialEventType: row.initialEventType as string,
		eventCount: Number(row.eventCount),
		lastEventAt: row.lastEventAt as string,
	}));

	return { items, nextCursor: hasMore ? String(offset + limit) : null };
}

async function getTimeline(
	eventStore: EventStore,
	correlationId: string,
): Promise<TimelineEvent[]> {
	const rows = await eventStore
		.with("latest", LATEST_STATE_CTE)
		.with("current_events", CURRENT_EVENTS_CTE)
		.where("correlationId", "=", correlationId)
		.selectAll()
		.orderBy("emittedAt", "asc")
		.execute();

	return rows as unknown as TimelineEvent[];
}

async function getDistinctEventTypes(
	eventStore: EventStore,
): Promise<string[]> {
	const rows = await eventStore
		.with("latest", LATEST_STATE_CTE)
		.with("current_events", CURRENT_EVENTS_CTE)
		.where("parentEventId", "is", null)
		.select(sql`DISTINCT type`.as("type"))
		.orderBy("type", "asc")
		.execute();

	// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE query results are untyped
	return (rows as any[]).map((r: any) => r.type as string);
}

async function getHeaderStats(eventStore: EventStore): Promise<HeaderStats> {
	const rows = await eventStore
		.with("latest", LATEST_STATE_CTE)
		.with("current_events", CURRENT_EVENTS_CTE)
		.with("summaries", (currentEvents) =>
			currentEvents
				.select(["correlationId"])
				.select(
					sql<string>`CASE
						WHEN COUNT(*) FILTER (WHERE state IN ('pending', 'processing')) > 0 THEN 'pending'
						WHEN COUNT(*) FILTER (WHERE result = 'failed') > 0 THEN 'failed'
						ELSE 'done'
					END`.as("aggregateState"),
				)
				.groupBy("correlationId"),
		)
		.where(sql`1`, "=", 1)
		.select(["aggregateState"])
		.select(sql<number>`COUNT(*)`.as("count"))
		.groupBy("aggregateState")
		.execute();

	const stats: HeaderStats = { pending: 0, failed: 0, done: 0 };
	// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE query results are untyped
	for (const row of rows as any[]) {
		if (row.aggregateState in stats) {
			stats[row.aggregateState as AggregateState] = Number(row.count);
		}
	}
	return stats;
}

async function getAllEventTypes(eventStore: EventStore): Promise<string[]> {
	const rows = await eventStore
		.with("latest", LATEST_STATE_CTE)
		.with("current_events", CURRENT_EVENTS_CTE)
		.where(sql`1`, "=", 1)
		.select(sql`DISTINCT type`.as("type"))
		.orderBy("type", "asc")
		.execute();

	// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE query results are untyped
	return (rows as any[]).map((r: any) => r.type as string);
}

export type {
	AggregateState,
	CorrelationListOptions,
	CorrelationListResult,
	CorrelationSummary,
	HeaderStats,
	TimelineEvent,
};
export {
	getAllEventTypes,
	getDistinctEventTypes,
	getHeaderStats,
	getTimeline,
	listCorrelations,
};
