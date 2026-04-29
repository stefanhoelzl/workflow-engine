import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	ImapTriggerDescriptor,
	ManualTriggerDescriptor,
	TriggerDescriptor,
	WsTriggerDescriptor,
} from "../../executor/types.js";
import type { WorkflowEntry } from "../../workflow-registry.js";
import { ChevronIcon, TriggerKindIcon } from "../icons.js";
import { Layout } from "../layout.js";

// ---------------------------------------------------------------------------
// Trigger UI — manual-fire form for registered triggers (any kind)
// ---------------------------------------------------------------------------
//
// Two page shapes:
//   - `renderTriggerTreePage` — index view at `/trigger` and
//     `/trigger/:owner`; collapsible `<details>` per owner / repo.
//   - `renderRepoTriggerPage` — leaf view at `/trigger/:owner/:repo`; one
//     collapsible card per registered trigger, grouped into per-workflow
//     sections. HTTP, cron, and manual cards all POST to the kind-agnostic
//     `/trigger/:owner/:repo/:workflow/:trigger` endpoint so the session
//     user can be captured as dispatch provenance.

// triggerCardMeta — formats descriptor-specific metadata. Inlined here as
// the single caller; was previously exported from `ui/triggers.ts` (now
// deleted). Returns plain text for display in the card meta chip.
function triggerCardMeta(
	descriptor: TriggerDescriptor,
	owner: string,
	repo: string,
	workflow: string,
): string {
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		return `${http.method} /webhooks/${owner}/${repo}/${workflow}/${http.name}`;
	}
	if (descriptor.kind === "cron") {
		const cron = descriptor as CronTriggerDescriptor;
		return `${cron.schedule} (${cron.tz})`;
	}
	if (descriptor.kind === "imap") {
		const imap = descriptor as ImapTriggerDescriptor;
		return `${imap.host}:${String(imap.port)} ${imap.folder}`;
	}
	if (descriptor.kind === "ws") {
		const ws = descriptor as WsTriggerDescriptor;
		return `ws /ws/${owner}/${repo}/${workflow}/${ws.name}`;
	}
	// manual — no meta line.
	return "";
}

function prepareSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") {
		return schema;
	}
	if (Array.isArray(schema)) {
		return schema.map(prepareSchema);
	}

	const obj = schema as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		result[key] = prepareSchema(value);
	}

	if (Array.isArray(result.anyOf)) {
		const variants = result.anyOf as Record<string, unknown>[];
		for (const v of variants) {
			if (!v.title && typeof v.type === "string") {
				v.title = v.type;
			}
		}
		const nullIdx = variants.findIndex((v) => v.type === "null");
		if (nullIdx > 0) {
			const [nil] = variants.splice(nullIdx, 1) as [Record<string, unknown>];
			variants.unshift(nil);
		}
	}

	if ("example" in result && !("default" in result)) {
		result.default = result.example;
	}

	return result;
}

// A schema with no `properties` and no `additionalProperties` has no
// user-settable fields — the card omits the form entirely and ships a bare
// Submit that posts `{}`.
function schemaHasNoInputs(schema: object): boolean {
	const obj = schema as Record<string, unknown>;
	const properties = obj.properties;
	const hasProperties =
		properties !== undefined &&
		typeof properties === "object" &&
		properties !== null &&
		Object.keys(properties as Record<string, unknown>).length > 0;
	const additional = obj.additionalProperties;
	const hasAdditional = additional !== undefined && additional !== false;
	return !(hasProperties || hasAdditional);
}

interface TriggerCardData {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly kind: string;
	readonly schema: object;
	readonly headersSchema?: object | null;
	readonly submitUrl: string;
	readonly submitMethod: string;
	readonly meta: string;
}

function TriggerCard({
	data,
	open,
}: {
	data: TriggerCardData;
	open?: boolean;
}) {
	const schemaJson = JSON.stringify(prepareSchema(data.schema));
	const cardId =
		`trigger-${data.owner}-${data.repo}-${data.workflow}-${data.trigger}`
			.replace(/[^a-zA-Z0-9_-]/g, "-")
			.toLowerCase();
	const empty = schemaHasNoInputs(data.schema);
	return (
		<details class="trigger-details" id={cardId} open={open ? true : undefined}>
			<summary class="trigger-summary">
				<span class="trigger-summary-chevron">
					<ChevronIcon />
				</span>
				<TriggerKindIcon kind={data.kind} />
				<span class="trigger-name">{data.trigger}</span>
				<span class="trigger-meta">
					<span class="trigger-meta-text">{data.meta}</span>
				</span>
			</summary>
			<div class="trigger-body">
				{empty ? null : <div class="form-container" />}
				<button
					type="button"
					class="submit-btn"
					data-trigger-url={data.submitUrl}
					data-trigger-method={data.submitMethod}
				>
					<span class="submit-btn-label">Submit</span>
				</button>
				<div class="trigger-result" />
			</div>
			<script type="application/json">{raw(schemaJson)}</script>
		</details>
	);
}

function entryToCardDataList(entry: WorkflowEntry): TriggerCardData[] {
	return entry.triggers.map((descriptor) =>
		descriptorToCardData(
			entry.owner,
			entry.repo,
			entry.workflow.name,
			descriptor,
		),
	);
}

function httpHeadersHasDeclaredProperties(
	headersSchema: Record<string, unknown> | undefined,
): boolean {
	if (!headersSchema || typeof headersSchema !== "object") {
		return false;
	}
	const properties = headersSchema.properties;
	if (!properties || typeof properties !== "object") {
		return false;
	}
	return Object.keys(properties as Record<string, unknown>).length > 0;
}

function composeHttpFormSchema(http: HttpTriggerDescriptor): object {
	const bodySchema = http.request.body ?? { type: "object" };
	if (!httpHeadersHasDeclaredProperties(http.request.headers)) {
		// No declared headers — render just the body form (today's flow).
		// The middleware accepts the bare body shape.
		return bodySchema as object;
	}
	// Declared headers — render an envelope form with two slots so Jedison
	// produces `{body, headers}` naturally and the form value posts as the
	// envelope shape the middleware accepts. The wrapper is `additional-
	// Properties: false` so the dispatch UI form can't grow extra fields.
	return {
		type: "object",
		properties: {
			body: bodySchema,
			headers: http.request.headers,
		},
		required: ["body", "headers"],
		additionalProperties: false,
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: per-kind dispatch — each branch builds the same TriggerCardData shape from a different descriptor type; splitting fragments the kind switch
function descriptorToCardData(
	owner: string,
	repo: string,
	workflow: string,
	descriptor: TriggerDescriptor,
): TriggerCardData {
	const meta = triggerCardMeta(descriptor, owner, repo, workflow);
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		// UI fires route through the authenticated /trigger/* endpoint so
		// the session user can be captured as dispatch provenance; the meta
		// chip still surfaces the public /webhooks/... URL documenting the
		// endpoint external callers use.
		return {
			owner,
			repo,
			workflow,
			trigger: http.name,
			kind: "http",
			schema: composeHttpFormSchema(http),
			headersSchema: (http.request.headers ?? null) as object | null,
			submitUrl: `/trigger/${owner}/${repo}/${workflow}/${http.name}`,
			submitMethod: "POST",
			meta,
		};
	}
	if (descriptor.kind === "cron") {
		const cron = descriptor as CronTriggerDescriptor;
		return {
			owner,
			repo,
			workflow,
			trigger: cron.name,
			kind: "cron",
			schema: (cron.inputSchema ?? { type: "object" }) as object,
			submitUrl: `/trigger/${owner}/${repo}/${workflow}/${cron.name}`,
			submitMethod: "POST",
			meta,
		};
	}
	if (descriptor.kind === "ws") {
		const ws = descriptor as WsTriggerDescriptor;
		// The trigger UI renders the form for the inbound `request` schema —
		// the manual-fire path wraps the submitted JSON as `{data: <input>}`
		// before dispatching to the handler. The schema served to jedison is
		// therefore the request schema (one level "deeper" than inputSchema).
		return {
			owner,
			repo,
			workflow,
			trigger: ws.name,
			kind: "ws",
			schema: (ws.request ?? { type: "object" }) as object,
			submitUrl: `/trigger/${owner}/${repo}/${workflow}/${ws.name}`,
			submitMethod: "POST",
			meta,
		};
	}
	// Manual + IMAP (and any future non-http/non-cron kinds) share the same
	// card shape: server-side input schema, POST to /trigger/.../<name>.
	// Carry through the descriptor's actual kind so the kind icon matches
	// (this used to hardcode "manual" and silently mis-render imap triggers).
	const other = descriptor as ManualTriggerDescriptor;
	return {
		owner,
		repo,
		workflow,
		trigger: other.name,
		kind: descriptor.kind,
		schema: (other.inputSchema ?? { type: "object" }) as object,
		submitUrl: `/trigger/${owner}/${repo}/${workflow}/${other.name}`,
		submitMethod: "POST",
		meta,
	};
}

interface RepoTriggerPageOptions {
	readonly entries: readonly WorkflowEntry[];
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly owner: string;
	readonly repo: string;
	readonly sidebarTree?: Child;
}

function RepoTriggerCards({ entries }: { entries: readonly WorkflowEntry[] }) {
	// Group cards by workflow, alpha-sort groups and triggers within groups.
	const byWorkflow = new Map<string, TriggerCardData[]>();
	for (const entry of entries) {
		const cards = entryToCardDataList(entry);
		const existing = byWorkflow.get(entry.workflow.name) ?? [];
		byWorkflow.set(entry.workflow.name, existing.concat(cards));
	}
	const groupNames = [...byWorkflow.keys()].sort((a, b) => a.localeCompare(b));
	if (groupNames.length === 0) {
		return <div class="empty-state">No triggers registered</div>;
	}
	return (
		<>
			{groupNames.map((name) => {
				const cards = (byWorkflow.get(name) ?? [])
					.slice()
					.sort((a, b) => a.trigger.localeCompare(b.trigger));
				return (
					<section class="trigger-group" aria-label={name}>
						<h2 class="trigger-group-title">{name}</h2>
						{cards.map((c) => (
							<TriggerCard data={c} />
						))}
					</section>
				);
			})}
		</>
	);
}

interface SingleTriggerPageOptions {
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly entries: readonly WorkflowEntry[];
	readonly sidebarTree?: Child;
}

function SingleTriggerPage(options: SingleTriggerPageOptions) {
	const { user, email, owner, repo, workflow, trigger, entries, sidebarTree } =
		options;
	let card: TriggerCardData | undefined;
	for (const entry of entries) {
		if (entry.workflow.name !== workflow) {
			continue;
		}
		for (const descriptor of entry.triggers) {
			if (descriptor.name === trigger) {
				card = descriptorToCardData(owner, repo, workflow, descriptor);
				break;
			}
		}
		if (card) {
			break;
		}
	}
	return (
		<Layout
			title={`Trigger — ${owner}/${repo} · ${workflow}/${trigger}`}
			activePath="/trigger"
			user={user}
			email={email}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
		>
			<div class="page-header">
				<nav class="breadcrumb" aria-label="Breadcrumb">
					<a href="/trigger">Trigger</a>
					<span class="breadcrumb-sep">/</span>
					<a href={`/trigger/${owner}`}>{owner}</a>
					<span class="breadcrumb-sep">/</span>
					<a href={`/trigger/${owner}/${repo}`}>{repo}</a>
					<span class="breadcrumb-sep">/</span>
					<span class="breadcrumb-current">{`${workflow} / ${trigger}`}</span>
				</nav>
				<h1>{`${workflow} / ${trigger}`}</h1>
			</div>
			<div class="trigger-content">
				{card ? (
					<TriggerCard data={card} open={true} />
				) : (
					<div class="empty-state">Trigger not found</div>
				)}
			</div>
		</Layout>
	);
}

function RepoTriggerPage(options: RepoTriggerPageOptions) {
	const { entries, user, email, owner, repo, sidebarTree } = options;
	return (
		<Layout
			title={`Trigger — ${owner}/${repo}`}
			activePath="/trigger"
			user={user}
			email={email}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
		>
			<div class="page-header">
				<nav class="breadcrumb" aria-label="Breadcrumb">
					<a href="/trigger">Trigger</a>
					<span class="breadcrumb-sep">/</span>
					<a href={`/trigger/${owner}`}>{owner}</a>
					<span class="breadcrumb-sep">/</span>
					<span class="breadcrumb-current">{repo}</span>
				</nav>
				<h1>{`${owner}/${repo}`}</h1>
			</div>
			<div class="trigger-content">
				<RepoTriggerCards entries={entries} />
			</div>
		</Layout>
	);
}

const SKELETON_PLACEHOLDERS = 3;

function TriggerSkeleton() {
	const items = Array.from({ length: SKELETON_PLACEHOLDERS });
	return (
		<>
			{items.map(() => (
				<div class="trigger-skeleton" aria-hidden="true" />
			))}
		</>
	);
}

function RepoList({
	owner,
	repos,
}: {
	owner: string;
	repos: readonly string[];
}) {
	if (repos.length === 0) {
		return (
			<div class="tree-empty" data-count="0">
				No repos registered
			</div>
		);
	}
	return (
		<ul class="tree-repos" data-owner={owner}>
			{repos.map((repo) => (
				<li class="tree-repo">
					<details
						hx-get={`/trigger/${owner}/${repo}/cards`}
						hx-trigger="toggle once"
						hx-target="find .tree-trigger-cards"
						hx-swap="innerHTML"
					>
						<summary class="tree-row">
							<span class="tree-chevron" aria-hidden="true">
								<ChevronIcon />
							</span>
							<span class="tree-label">{repo}</span>
						</summary>
						<div class="tree-trigger-cards">
							<TriggerSkeleton />
						</div>
					</details>
				</li>
			))}
		</ul>
	);
}

function TriggerRepoNode({
	owner,
	repo,
	autoExpand,
	preloadedEntries,
}: {
	owner: string;
	repo: string;
	autoExpand: boolean;
	preloadedEntries: readonly WorkflowEntry[] | undefined;
}) {
	return (
		<li class="tree-repo">
			<details
				open={autoExpand ? true : undefined}
				hx-get={`/trigger/${owner}/${repo}/cards`}
				hx-trigger="toggle once"
				hx-target="find .tree-trigger-cards"
				hx-swap="innerHTML"
			>
				<summary class="tree-row">
					<span class="tree-chevron" aria-hidden="true">
						<ChevronIcon />
					</span>
					<span class="tree-label">{repo}</span>
				</summary>
				<div class="tree-trigger-cards">
					{autoExpand && preloadedEntries ? (
						<RepoTriggerCards entries={preloadedEntries} />
					) : (
						<TriggerSkeleton />
					)}
				</div>
			</details>
		</li>
	);
}

function TriggerOwnerNode({
	owner,
	repos,
	autoExpand,
	autoExpandRepo,
	preloadedEntries,
}: {
	owner: string;
	repos: readonly string[] | undefined;
	autoExpand: string | undefined;
	autoExpandRepo: string | undefined;
	preloadedEntries: readonly WorkflowEntry[] | undefined;
}) {
	if (!repos || repos.length === 0) {
		return (
			<li class="tree-owner tree-owner--empty">
				<div class="tree-row tree-row--flat">
					<span class="tree-label">{owner}</span>
					<span class="tree-note">no repos registered</span>
				</div>
			</li>
		);
	}
	const open = autoExpand === owner;
	return (
		<li class="tree-owner">
			<details open={open ? true : undefined}>
				<summary class="tree-row">
					<span class="tree-chevron" aria-hidden="true">
						<ChevronIcon />
					</span>
					<span class="tree-label">{owner}</span>
				</summary>
				<div class="tree-owner-body">
					<ul class="tree-repos">
						{repos.map((repo) => (
							<TriggerRepoNode
								owner={owner}
								repo={repo}
								autoExpand={autoExpand === owner && autoExpandRepo === repo}
								preloadedEntries={
									autoExpand === owner && autoExpandRepo === repo
										? preloadedEntries
										: undefined
								}
							/>
						))}
					</ul>
				</div>
			</details>
		</li>
	);
}

interface TriggerIndexPageOptions {
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly reposByOwner: Record<string, readonly string[]>;
	readonly autoExpand?: string;
	readonly autoExpandRepo?: string;
	readonly preloadedEntries?: readonly WorkflowEntry[];
	readonly sidebarTree?: Child;
}

function TriggerIndexPage(options: TriggerIndexPageOptions) {
	const {
		user,
		email,
		owners,
		reposByOwner,
		autoExpand,
		autoExpandRepo,
		preloadedEntries,
		sidebarTree,
	} = options;
	return (
		<Layout
			title="Trigger"
			activePath="/trigger"
			user={user}
			email={email}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
		>
			<div class="page-header">
				<h1>Trigger</h1>
			</div>
			<div class="dashboard-tree">
				{owners.length === 0 ? (
					<div class="empty-state">No owners available</div>
				) : (
					<ul class="tree-owners">
						{owners.map((owner) => (
							<TriggerOwnerNode
								owner={owner}
								repos={reposByOwner[owner]}
								autoExpand={autoExpand}
								autoExpandRepo={autoExpandRepo}
								preloadedEntries={preloadedEntries}
							/>
						))}
					</ul>
				)}
			</div>
		</Layout>
	);
}

// ---------------------------------------------------------------------------
// Compat shims — return strings via .toString() so c.html() accepts directly.
// ---------------------------------------------------------------------------

function renderRepoTriggerCards(entries: readonly WorkflowEntry[]) {
	return (<RepoTriggerCards entries={entries} />).toString();
}

function renderRepoTriggerPage(options: RepoTriggerPageOptions) {
	return (<RepoTriggerPage {...options} />).toString();
}

function renderSingleTriggerPage(options: SingleTriggerPageOptions) {
	return (<SingleTriggerPage {...options} />).toString();
}

function renderRepoList(owner: string, repos: readonly string[]) {
	return (<RepoList owner={owner} repos={repos} />).toString();
}

function renderTriggerIndexPage(options: TriggerIndexPageOptions) {
	return (<TriggerIndexPage {...options} />).toString();
}

// Attach the repo-list fragment renderer as a static for the HTMX endpoint.
renderTriggerIndexPage.repoListFragment = renderRepoList;

export type { TriggerCardData };
export {
	prepareSchema,
	RepoTriggerCards,
	RepoTriggerPage,
	renderRepoTriggerCards,
	renderRepoTriggerPage,
	renderSingleTriggerPage,
	renderTriggerIndexPage,
	SingleTriggerPage,
	schemaHasNoInputs,
	TriggerIndexPage,
};
