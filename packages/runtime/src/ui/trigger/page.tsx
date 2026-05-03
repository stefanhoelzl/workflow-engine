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
//   - `ScopeTriggerPage` — every multi-card scope (`/trigger`,
//     `/trigger/:owner`, `/trigger/:owner/:repo`,
//     `/trigger/:owner/:repo/:workflow`). One `<section>` per workflow;
//     section heading is the path *relative* to the current scope down to
//     the workflow (omitted at workflow scope, where the tabbar breadcrumb
//     already names it).
//   - `SingleTriggerPage` — leaf view at
//     `/trigger/:owner/:repo/:workflow/:trigger`; renders the named trigger
//     pre-expanded.
//
// HTTP, cron, and manual cards all POST to the kind-agnostic
// `/trigger/:owner/:repo/:workflow/:trigger` endpoint so the session user
// can be captured as dispatch provenance. Navigation across scopes is the
// sidebar tree's job; in-page breadcrumbs/headings are gone and live in
// the shared tabbar (`tabs.tsx`).

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
	readonly tabs?: Child;
}

function RepoTriggerCards({ entries }: { entries: readonly WorkflowEntry[] }) {
	// Flat list of cards across the supplied entries (alpha-sorted by trigger
	// name). Per-workflow grouping at the page level is handled by the scope
	// renderer so it can compute the relative-path heading.
	const cards = entries
		.flatMap((entry) => entryToCardDataList(entry))
		.sort((a, b) => a.trigger.localeCompare(b.trigger));
	if (cards.length === 0) {
		return <div class="empty-state">No triggers registered</div>;
	}
	return (
		<>
			{cards.map((c) => (
				<TriggerCard data={c} />
			))}
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
	readonly tabs?: Child;
}

function SingleTriggerPage(options: SingleTriggerPageOptions) {
	const {
		user,
		email,
		owner,
		repo,
		workflow,
		trigger,
		entries,
		sidebarTree,
		tabs,
	} = options;
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
			{...(tabs === undefined ? {} : { tabs })}
		>
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

// ---------------------------------------------------------------------------
// Scope-filtered page — single component used at every multi-card scope:
//   /trigger                                — every (owner, repo) the user has
//   /trigger/:owner                         — every repo under :owner
//   /trigger/:owner/:repo                   — single repo, every workflow
//   /trigger/:owner/:repo/:workflow         — single workflow's cards
// The single-trigger leaf (`/trigger/:owner/:repo/:workflow/:trigger`) keeps
// its own focused page. Navigation between scopes is the sidebar tree's job
// (`shared-layout`); no inline-expandable tree, no HTMX fragment lazy-load.

interface ScopeTriggerPageOptions {
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly entries: readonly WorkflowEntry[];
	readonly scope: {
		readonly owner?: string;
		readonly repo?: string;
		readonly workflow?: string;
	};
	readonly sidebarTree?: Child;
	readonly tabs?: Child;
}

function scopeTitle(scope: ScopeTriggerPageOptions["scope"]): string {
	if (!scope.owner) {
		return "Trigger";
	}
	if (!scope.repo) {
		return scope.owner;
	}
	if (!scope.workflow) {
		return `${scope.owner}/${scope.repo}`;
	}
	return `${scope.owner}/${scope.repo} · ${scope.workflow}`;
}

// Heading shown above each per-workflow card section. Path is *relative* to
// the current scope, down to the workflow grouping. At workflow scope (and
// the leaf single-trigger page) the heading is omitted entirely.
function relativeWorkflowPath(
	scope: ScopeTriggerPageOptions["scope"],
	owner: string,
	repo: string,
	workflow: string,
): string | null {
	if (!scope.owner) {
		return `${owner}/${repo}/${workflow}`;
	}
	if (!scope.repo) {
		return `${repo}/${workflow}`;
	}
	if (!scope.workflow) {
		return workflow;
	}
	return null;
}

function ScopeTriggerPage(options: ScopeTriggerPageOptions) {
	const { user, email, scope, entries, sidebarTree, tabs } = options;
	// Group entries by (owner, repo, workflow) — one section per workflow at
	// every scope. Sort by the composite key so the rendering order is stable
	// across reloads.
	const byWorkflow = new Map<string, WorkflowEntry[]>();
	for (const entry of entries) {
		const key = `${entry.owner}/${entry.repo}/${entry.workflow.name}`;
		const bucket = byWorkflow.get(key) ?? [];
		bucket.push(entry);
		byWorkflow.set(key, bucket);
	}
	const groupKeys = [...byWorkflow.keys()].sort((a, b) => a.localeCompare(b));
	return (
		<Layout
			title={`Trigger — ${scopeTitle(scope)}`}
			activePath="/trigger"
			user={user}
			email={email}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
			{...(tabs === undefined ? {} : { tabs })}
		>
			<div class="trigger-content">
				{groupKeys.length === 0 ? (
					<div class="empty-state">No triggers registered</div>
				) : (
					groupKeys.map((key) => {
						const bucket = byWorkflow.get(key) ?? [];
						const first = bucket[0];
						if (!first) {
							return null;
						}
						const heading = relativeWorkflowPath(
							scope,
							first.owner,
							first.repo,
							first.workflow.name,
						);
						return (
							<section class="trigger-group" aria-label={first.workflow.name}>
								{heading ? (
									<h2 class="trigger-group-title">{heading}</h2>
								) : null}
								<RepoTriggerCards entries={bucket} />
							</section>
						);
					})
				)}
			</div>
		</Layout>
	);
}

function RepoTriggerPage(options: RepoTriggerPageOptions) {
	const { entries, user, email, owner, repo, sidebarTree, tabs } = options;
	return (
		<ScopeTriggerPage
			user={user}
			email={email}
			owners={options.owners}
			entries={entries}
			scope={{ owner, repo }}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
			{...(tabs === undefined ? {} : { tabs })}
		/>
	);
}

// ---------------------------------------------------------------------------
// Compat shims — return strings via .toString() so c.html() accepts directly.
// ---------------------------------------------------------------------------

function renderRepoTriggerPage(options: RepoTriggerPageOptions) {
	return (<RepoTriggerPage {...options} />).toString();
}

function renderSingleTriggerPage(options: SingleTriggerPageOptions) {
	return (<SingleTriggerPage {...options} />).toString();
}

function renderScopeTriggerPage(options: ScopeTriggerPageOptions) {
	return (<ScopeTriggerPage {...options} />).toString();
}

export type { ScopeTriggerPageOptions, TriggerCardData };
export {
	prepareSchema,
	RepoTriggerCards,
	RepoTriggerPage,
	renderRepoTriggerPage,
	renderScopeTriggerPage,
	renderSingleTriggerPage,
	ScopeTriggerPage,
	SingleTriggerPage,
	schemaHasNoInputs,
};
