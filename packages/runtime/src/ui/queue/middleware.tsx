import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { ownerSet } from "../../auth/owner.js";
import { requireOwnerMember } from "../../auth/owner-mw.js";
import { createNotFoundHandler } from "../../services/content-negotiation.js";
import type { Middleware } from "../../triggers/http.js";
import type {
	WorkflowEntry,
	WorkflowRegistry,
} from "../../workflow-registry.js";
import { buildSidebarData, SidebarTree } from "../sidebar-tree.js";
import { Tabs } from "../tabs.js";
import {
	ItemsFragment,
	type QueueCardData,
	renderScopeQueuePage,
} from "./page.js";
import { countQueueItems, listQueueItems } from "./queue-read.js";

// ---------------------------------------------------------------------------
// /queue/* — operator UI for inspecting per-workflow durable FIFO queues.
//
// Read-only mirror of the `/trigger` surface. Same auth contract: sealed
// session cookie + `requireOwnerMember()` + 404-fail-closed for non-members.
// Item-count card stats and the lazy items fragment both go through the
// host-side read primitive in `queue-read.ts`, which honours the queue file
// invariants (read-only, non-blocking, partial-trailing-line tolerant) per
// `queues/spec.md` (Host-side read-only inspection).
//
// Routes:
//   GET /queue                                                — every queue card across user's owners
//   GET /queue/:owner                                         — every queue under :owner
//   GET /queue/:owner/:repo                                   — every queue under (owner, repo)
//   GET /queue/:owner/:repo/:workflow                         — every queue declared by one workflow
//   GET /queue/:owner/:repo/:workflow/:queue/items?offset=N   — server-rendered HTML fragment of 50 items
// ---------------------------------------------------------------------------

const ITEMS_PAGE_SIZE = 50;

interface QueueMiddlewareDeps {
	readonly registry: WorkflowRegistry;
	readonly sessionMw: MiddlewareHandler;
	readonly queuesRoot: string;
}

interface QueueRef {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queue: string;
}

function sortedOwners(c: Context): string[] {
	const user = c.get("user");
	return user ? Array.from(ownerSet(user)).sort() : [];
}

function queueRefsFromEntry(entry: WorkflowEntry): readonly QueueRef[] {
	const out: QueueRef[] = [];
	for (const q of entry.workflow.queues) {
		out.push({
			owner: entry.owner,
			repo: entry.repo,
			workflow: entry.workflow.name,
			queue: q.name,
		});
	}
	return out;
}

function adaptiveTitle(
	ref: QueueRef,
	scope: { owner?: string; repo?: string; workflow?: string },
): string {
	if (!scope.owner) {
		return `${ref.owner}/${ref.repo}/${ref.workflow}/${ref.queue}`;
	}
	if (!scope.repo) {
		return `${ref.repo}/${ref.workflow}/${ref.queue}`;
	}
	if (!scope.workflow) {
		return `${ref.workflow}/${ref.queue}`;
	}
	return ref.queue;
}

function itemsUrl(ref: QueueRef): string {
	return `/queue/${ref.owner}/${ref.repo}/${ref.workflow}/${ref.queue}/items`;
}

async function buildCardsForRefs(
	refs: readonly QueueRef[],
	scope: { owner?: string; repo?: string; workflow?: string },
	queuesRoot: string,
): Promise<QueueCardData[]> {
	const cards = await Promise.all(
		refs.map(async (ref) => {
			const count = await countQueueItems({ queuesRoot, ...ref });
			return {
				owner: ref.owner,
				repo: ref.repo,
				workflow: ref.workflow,
				queue: ref.queue,
				count,
				title: adaptiveTitle(ref, scope),
				itemsUrl: itemsUrl(ref),
			};
		}),
	);
	cards.sort((a, b) => a.title.localeCompare(b.title));
	return cards;
}

function entriesForOwner(
	registry: WorkflowRegistry,
	owner: string,
): WorkflowEntry[] {
	const out: WorkflowEntry[] = [];
	for (const repo of registry.repos(owner)) {
		for (const entry of registry.list(owner, repo)) {
			out.push(entry);
		}
	}
	return out;
}

function entriesAcrossOwners(
	registry: WorkflowRegistry,
	owners: readonly string[],
): WorkflowEntry[] {
	const out: WorkflowEntry[] = [];
	for (const o of owners) {
		out.push(...entriesForOwner(registry, o));
	}
	return out;
}

function refsFromEntries(
	entries: readonly WorkflowEntry[],
): readonly QueueRef[] {
	const out: QueueRef[] = [];
	for (const e of entries) {
		out.push(...queueRefsFromEntry(e));
	}
	return out;
}

function parseOffset(c: Context): number {
	const raw = c.req.query("offset");
	if (typeof raw !== "string" || raw === "") {
		return 0;
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) {
		return 0;
	}
	return n;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires four GET drill-down levels + items fragment endpoint; splitting fragments the handler flow
function queueMiddleware(deps: QueueMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/queue");
	app.use("*", deps.sessionMw);
	app.use("/:owner/*", requireOwnerMember());
	app.use("/:owner", requireOwnerMember());
	app.use("/:owner/:repo/*", requireOwnerMember());
	app.use("/:owner/:repo", requireOwnerMember());
	app.notFound(createNotFoundHandler());

	function buildSidebar(
		owners: readonly string[],
		activeOwner?: string,
		activeRepo?: string,
		activeWorkflow?: string,
	) {
		const data = buildSidebarData(deps.registry, owners);
		return (
			<SidebarTree
				surface="/queue"
				data={data}
				active={{
					...(activeOwner ? { owner: activeOwner } : {}),
					...(activeRepo ? { repo: activeRepo } : {}),
					...(activeWorkflow ? { workflow: activeWorkflow } : {}),
				}}
			/>
		);
	}

	function tabsFor(
		activeOwner?: string,
		activeRepo?: string,
		activeWorkflow?: string,
	) {
		const path = `/${[activeOwner, activeRepo, activeWorkflow]
			.filter((s): s is string => Boolean(s))
			.join("/")}`;
		const cleaned = path === "/" ? "" : path;
		const scope = {
			...(activeOwner ? { owner: activeOwner } : {}),
			...(activeRepo ? { repo: activeRepo } : {}),
			...(activeWorkflow ? { workflow: activeWorkflow } : {}),
		};
		return <Tabs surface="/queue" path={cleaned} scope={scope} />;
	}

	// -- Root: /queue ------------------------------------------------------
	const renderRoot = async (c: Context) => {
		const user = c.get("user");
		const owners = sortedOwners(c);
		const refs = refsFromEntries(entriesAcrossOwners(deps.registry, owners));
		const cards = await buildCardsForRefs(refs, {}, deps.queuesRoot);
		return c.html(
			renderScopeQueuePage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				cards,
				scope: {},
				sidebarTree: buildSidebar(owners),
				tabs: tabsFor(),
			}),
		);
	};
	app.get("/", renderRoot);
	app.get("", renderRoot);

	// -- /queue/:owner -----------------------------------------------------
	app.get("/:owner", async (c) => {
		const owner = c.req.param("owner");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const refs = refsFromEntries(entriesForOwner(deps.registry, owner));
		const cards = await buildCardsForRefs(refs, { owner }, deps.queuesRoot);
		return c.html(
			renderScopeQueuePage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				cards,
				scope: { owner },
				sidebarTree: buildSidebar(owners, owner),
				tabs: tabsFor(owner),
			}),
		);
	});

	// -- /queue/:owner/:repo ----------------------------------------------
	app.get("/:owner/:repo", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const user = c.get("user");
		const owners = sortedOwners(c);
		const refs = refsFromEntries(deps.registry.list(owner, repo));
		const cards = await buildCardsForRefs(
			refs,
			{ owner, repo },
			deps.queuesRoot,
		);
		return c.html(
			renderScopeQueuePage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				cards,
				scope: { owner, repo },
				sidebarTree: buildSidebar(owners, owner, repo),
				tabs: tabsFor(owner, repo),
			}),
		);
	});

	// -- /queue/:owner/:repo/:workflow ------------------------------------
	app.get("/:owner/:repo/:workflow", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const workflow = c.req.param("workflow");
		const entries = deps.registry
			.list(owner, repo)
			.filter((e) => e.workflow.name === workflow);
		if (entries.length === 0) {
			return c.notFound();
		}
		const user = c.get("user");
		const owners = sortedOwners(c);
		const refs = refsFromEntries(entries);
		const cards = await buildCardsForRefs(
			refs,
			{ owner, repo, workflow },
			deps.queuesRoot,
		);
		return c.html(
			renderScopeQueuePage({
				user: user?.login ?? "",
				email: user?.mail ?? "",
				cards,
				scope: { owner, repo, workflow },
				sidebarTree: buildSidebar(owners, owner, repo, workflow),
				tabs: tabsFor(owner, repo, workflow),
			}),
		);
	});

	// -- /queue/:owner/:repo/:workflow/:queue/items ----------------------
	app.get("/:owner/:repo/:workflow/:queue/items", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const workflow = c.req.param("workflow");
		const queue = c.req.param("queue");
		const entry = deps.registry
			.list(owner, repo)
			.find((e) => e.workflow.name === workflow);
		if (!entry) {
			return c.notFound();
		}
		const declared = entry.workflow.queues.some((q) => q.name === queue);
		if (!declared) {
			return c.notFound();
		}
		const offset = parseOffset(c);
		const { items, total } = await listQueueItems({
			queuesRoot: deps.queuesRoot,
			owner,
			repo,
			workflow,
			queue,
			offset,
			limit: ITEMS_PAGE_SIZE,
		});
		const html = ItemsFragment({
			owner,
			repo,
			workflow,
			queue,
			items,
			offset,
			total,
		});
		return c.html(html);
	});

	return {
		match: "/queue/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { QueueMiddlewareDeps };
export { queueMiddleware };
