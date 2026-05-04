import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { ChevronIcon } from "../icons.js";
import { Layout } from "../layout.js";

// ---------------------------------------------------------------------------
// /queue/* — operator UI for inspecting per-workflow durable FIFO queues.
//
// Read-only. Cards are server-rendered with eager item counts; the body is
// empty on initial render and a click-to-expand fetches a server-rendered
// HTML fragment of the first 50 items (see `items-fragment.tsx`). Items
// render via the shared `wfeJsonTree` Alpine component so the visual
// affordance matches `result-dialog.js` after that file's migration.
// ---------------------------------------------------------------------------

interface QueueCardData {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queue: string;
	readonly count: number;
	// Title shown on the collapsed card. Adaptive by current scope:
	// at /queue → "owner/repo/workflow/queue"; at /queue/owner → "repo/.../queue";
	// at /queue/owner/repo → "workflow/queue"; at /queue/owner/repo/workflow → "queue".
	readonly title: string;
	// URL of the lazy items fragment (offset=0 form, no query suffix needed).
	readonly itemsUrl: string;
}

function cardId(d: QueueCardData): string {
	return `queue-${d.owner}-${d.repo}-${d.workflow}-${d.queue}`
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.toLowerCase();
}

function QueueCard({ data }: { data: QueueCardData }) {
	// Empty queues render as a non-expandable <div> so there's no chevron and
	// no click affordance — there's nothing to load. Non-empty queues render
	// as <details> wired to the lazy items fragment.
	if (data.count === 0) {
		return (
			<div class="queue-details queue-details-empty" id={cardId(data)}>
				<div class="queue-summary queue-summary-empty">
					<span class="queue-name">{data.title}</span>
					<span class="queue-meta">
						<span class="queue-count">0</span>
						<span class="queue-count-label">items</span>
					</span>
				</div>
			</div>
		);
	}
	return (
		<details
			class="queue-details"
			id={cardId(data)}
			data-queue-items-url={data.itemsUrl}
			x-data="wfeQueueCard"
		>
			<summary class="queue-summary">
				<span class="queue-summary-chevron">
					<ChevronIcon />
				</span>
				<span class="queue-name">{data.title}</span>
				<span class="queue-meta">
					<span class="queue-count">{String(data.count)}</span>
					<span class="queue-count-label">
						{data.count === 1 ? "item" : "items"}
					</span>
				</span>
			</summary>
			<div class="queue-body">
				<div class="queue-items" data-queue-items={true} />
			</div>
		</details>
	);
}

interface ScopeQueuePageOptions {
	readonly user: string;
	readonly email: string;
	readonly cards: readonly QueueCardData[];
	readonly scope: {
		readonly owner?: string;
		readonly repo?: string;
		readonly workflow?: string;
	};
	readonly sidebarTree?: Child;
	readonly tabs?: Child;
}

function scopeTitle(scope: ScopeQueuePageOptions["scope"]): string {
	if (!scope.owner) {
		return "Queues";
	}
	if (!scope.repo) {
		return scope.owner;
	}
	if (!scope.workflow) {
		return `${scope.owner}/${scope.repo}`;
	}
	return `${scope.owner}/${scope.repo} · ${scope.workflow}`;
}

function ScopeQueuePage(options: ScopeQueuePageOptions) {
	const { user, email, scope, cards, sidebarTree, tabs } = options;
	return (
		<Layout
			title={`Queues — ${scopeTitle(scope)}`}
			activePath="/queue"
			user={user}
			email={email}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
			{...(tabs === undefined ? {} : { tabs })}
		>
			<div class="queue-content">
				{cards.length === 0 ? (
					<div class="empty-state">No queues declared</div>
				) : (
					cards.map((c) => <QueueCard data={c} />)
				)}
			</div>
		</Layout>
	);
}

function renderScopeQueuePage(options: ScopeQueuePageOptions): string {
	return (<ScopeQueuePage {...options} />).toString();
}

// ---------------------------------------------------------------------------
// Items fragment — returned by GET /queue/:owner/:repo/:workflow/:queue/items.
// Server-rendered HTML fragment (no <html>/<head>/<body>) appended into the
// expanded card's body by Alpine. Each item renders via the shared JSON-tree
// component; a "Load more" control is included when more items remain.
// ---------------------------------------------------------------------------

interface ItemsFragmentOptions {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queue: string;
	readonly items: readonly unknown[];
	readonly offset: number;
	readonly total: number;
}

function ItemBlock({ item }: { item: unknown }) {
	const json = JSON.stringify(item);
	return (
		<article class="queue-item" x-data="wfeJsonTree" data-json={json}>
			<div class="queue-item-tree" data-json-tree-mount={true} />
		</article>
	);
}

function LoadMore({
	owner,
	repo,
	workflow,
	queue,
	nextOffset,
}: {
	owner: string;
	repo: string;
	workflow: string;
	queue: string;
	nextOffset: number;
}) {
	const url = `/queue/${owner}/${repo}/${workflow}/${queue}/items?offset=${String(nextOffset)}`;
	return (
		<button
			type="button"
			class="queue-load-more"
			data-queue-load-more={true}
			data-queue-items-url={url}
		>
			Load more
		</button>
	);
}

function ItemsFragment(options: ItemsFragmentOptions): string {
	const { owner, repo, workflow, queue, items, offset, total } = options;
	const next = offset + items.length;
	const hasMore = next < total;
	const fragment = (
		<>
			{items.length === 0 && offset === 0 ? (
				<div class="queue-empty">Queue is empty</div>
			) : null}
			{items.map((item) => (
				<ItemBlock item={item} />
			))}
			{hasMore ? (
				<LoadMore
					owner={owner}
					repo={repo}
					workflow={workflow}
					queue={queue}
					nextOffset={next}
				/>
			) : null}
		</>
	);
	return fragment.toString();
}

// raw() is used by callers that need to compose the fragment into a larger
// JSX response; the middleware just streams the string.
function rawFragment(html: string): ReturnType<typeof raw> {
	return raw(html);
}

export type { ItemsFragmentOptions, QueueCardData, ScopeQueuePageOptions };
export { ItemsFragment, rawFragment, renderScopeQueuePage, ScopeQueuePage };
