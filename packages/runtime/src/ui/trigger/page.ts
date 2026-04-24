import { html, raw } from "hono/html";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	ManualTriggerDescriptor,
	TriggerDescriptor,
} from "../../executor/types.js";
import type { WorkflowEntry } from "../../workflow-registry.js";
import { renderLayout } from "../layout.js";
import { triggerCardMeta, triggerKindIcon } from "../triggers.js";

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
	readonly submitUrl: string;
	readonly submitMethod: string;
	readonly meta: string;
}

const chevronIconSvg = raw(
	// biome-ignore lint/security/noSecrets: inline SVG markup, not a secret
	'<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
);

function renderTriggerCard(data: TriggerCardData) {
	const schemaJson = JSON.stringify(prepareSchema(data.schema));
	const cardId =
		`trigger-${data.owner}-${data.repo}-${data.workflow}-${data.trigger}`
			.replace(/[^a-zA-Z0-9_-]/g, "-")
			.toLowerCase();
	const empty = schemaHasNoInputs(data.schema);
	return html`<details class="trigger-details" id="${cardId}">
      <summary class="trigger-summary">
        <span class="trigger-summary-chevron">${chevronIconSvg}</span>
        ${triggerKindIcon(data.kind)}
        <span class="trigger-name">${data.trigger}</span>
        <span class="trigger-meta"><span class="trigger-meta-text">${data.meta}</span></span>
      </summary>
      <div class="trigger-body">
        ${empty ? "" : html`<div class="form-container"></div>`}
        <button
          type="button"
          class="submit-btn"
          data-trigger-url="${data.submitUrl}"
          data-trigger-method="${data.submitMethod}"
        ><span class="submit-btn-label">Submit</span></button>
        <div class="trigger-result"></div>
      </div>
      <script type="application/json">${raw(schemaJson)}</script>
    </details>`;
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
			schema: (http.body ?? { type: "object" }) as object,
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
	const manual = descriptor as ManualTriggerDescriptor;
	return {
		owner,
		repo,
		workflow,
		trigger: manual.name,
		kind: "manual",
		schema: (manual.inputSchema ?? { type: "object" }) as object,
		submitUrl: `/trigger/${owner}/${repo}/${workflow}/${manual.name}`,
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
}

function renderRepoTriggerPage(options: RepoTriggerPageOptions) {
	const { entries, user, email, owners, owner, repo } = options;

	// Group cards by workflow, alpha-sort groups and triggers within groups.
	const byWorkflow = new Map<string, TriggerCardData[]>();
	for (const entry of entries) {
		const cards = entryToCardDataList(entry);
		const existing = byWorkflow.get(entry.workflow.name) ?? [];
		byWorkflow.set(entry.workflow.name, existing.concat(cards));
	}
	const groupNames = [...byWorkflow.keys()].sort((a, b) => a.localeCompare(b));
	const groups = groupNames.map((name) => {
		const cards = (byWorkflow.get(name) ?? [])
			.slice()
			.sort((a, b) => a.trigger.localeCompare(b.trigger))
			.map(renderTriggerCard);
		return html`<section class="trigger-group" aria-label="${name}">
      <h2 class="trigger-group-title">${name}</h2>
      ${cards}
    </section>`;
	});

	const head = html`  <link rel="stylesheet" href="/static/trigger.css">
  <script src="/static/jedison.js"></script>
  <script defer src="/static/trigger-forms.js"></script>`;

	const content = html`
  <div class="page-header">
    <h1>Trigger — ${owner}/${repo}</h1>
  </div>

  <div class="trigger-content">
    ${groups.length > 0 ? groups : html`<div class="empty-state">No triggers registered</div>`}
  </div>`;

	return renderLayout(
		{
			title: "Trigger",
			activePath: "/trigger",
			user,
			email,
			head,
			owners,
		},
		content,
	);
}

interface TriggerTreePageOptions {
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly reposByOwner: Record<string, readonly string[]>;
	readonly autoExpand?: string;
}

function renderTriggerTreePage(options: TriggerTreePageOptions) {
	const { user, email, owners, reposByOwner, autoExpand } = options;
	const content =
		owners.length === 0
			? html`<div class="empty-state">No owners available</div>`
			: html`<ul class="tree-owners">
      ${owners.map((owner) => {
				const open = autoExpand === owner ? raw(" open") : "";
				const repos = reposByOwner[owner];
				const body = repos
					? html`<ul class="tree-repos">
              ${repos.map(
								(repo) =>
									html`<li class="tree-repo">
                    <a href="/trigger/${owner}/${repo}">${repo}</a>
                  </li>`,
							)}
            </ul>`
					: html`<div class="tree-placeholder"><a href="/trigger/${owner}">View repos</a></div>`;
				return html`<li class="tree-owner">
          <details${open}>
            <summary><span class="tree-label">${owner}</span></summary>
            <div class="tree-owner-body">${body}</div>
          </details>
        </li>`;
			})}
    </ul>`;

	const head = html`  <link rel="stylesheet" href="/static/trigger.css">`;
	const body = html`
  <div class="page-header">
    <h1>Trigger</h1>
  </div>
  <div class="trigger-content">${content}</div>`;

	return renderLayout(
		{
			title: "Trigger",
			activePath: "/trigger",
			user,
			email,
			head,
			owners,
		},
		body,
	);
}

export type { TriggerCardData };
export {
	prepareSchema,
	renderRepoTriggerPage,
	renderTriggerTreePage,
	schemaHasNoInputs,
};
