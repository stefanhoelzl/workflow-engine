import { html, raw } from "hono/html";
import type {
	HttpTriggerDescriptor,
	TriggerDescriptor,
} from "../../executor/types.js";
import type { WorkflowEntry } from "../../workflow-registry.js";
import { renderLayout } from "../layout.js";

// ---------------------------------------------------------------------------
// Trigger UI — manual-fire form for registered triggers (any kind)
// ---------------------------------------------------------------------------
//
// One collapsible card per registered trigger. For HTTP kind the form is
// built from `descriptor.body` (the body JSON Schema) and the Submit button
// POSTs to the public webhook URL — the HTTP source fills in
// headers/url/method/params/query from the real HTTP request. For non-HTTP
// kinds (future cron/mail) the form is built from the full
// `descriptor.inputSchema` and POSTs to the kind-agnostic
// `/trigger/<tenant>/<workflow>/<trigger-name>` endpoint.

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

// Kind → glyph mapping. Add a new line per new trigger kind. The `title`
// attribute surfaces the kind on hover.
const KIND_ICONS: Record<string, string> = {
	http: "\u{1F310}", // globe
};

function kindIcon(kind: string) {
	const glyph = KIND_ICONS[kind] ?? "\u{25CF}";
	return html`<span class="trigger-kind-icon" title="${kind}" aria-label="${kind}">${glyph}</span>`;
}

interface TriggerCardData {
	readonly tenant: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly kind: string;
	readonly schema: object;
	readonly submitUrl: string;
	readonly submitMethod: string;
	readonly meta?: string;
}

function renderTriggerCard(data: TriggerCardData) {
	const schemaJson = JSON.stringify(prepareSchema(data.schema));
	const cardId = `trigger-${data.tenant}-${data.workflow}-${data.trigger}`
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.toLowerCase();
	return html`<details class="trigger-details" id="${cardId}">
      <summary class="trigger-summary">
        ${kindIcon(data.kind)}
        <span class="trigger-name">${data.workflow} / ${data.trigger}</span>
        ${data.meta ? html`<span class="trigger-meta">${data.meta}</span>` : ""}
      </summary>
      <div class="trigger-body">
        <div class="form-container"></div>
        <button
          type="button"
          class="submit-btn"
          data-trigger-url="${data.submitUrl}"
          data-trigger-method="${data.submitMethod}"
        >Submit</button>
        <div class="trigger-result"></div>
      </div>
      <script type="application/json">${raw(schemaJson)}</script>
    </details>`;
}

function entryToCardDataList(entry: WorkflowEntry): TriggerCardData[] {
	return entry.triggers.map((descriptor) =>
		descriptorToCardData(entry.tenant, entry.workflow.name, descriptor),
	);
}

function descriptorToCardData(
	tenant: string,
	workflow: string,
	descriptor: TriggerDescriptor,
): TriggerCardData {
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		const webhookUrl = `/webhooks/${tenant}/${workflow}/${http.path}`;
		return {
			tenant,
			workflow,
			trigger: http.name,
			kind: "http",
			schema: (http.body ?? { type: "object" }) as object,
			submitUrl: webhookUrl,
			submitMethod: http.method,
			meta: `${http.method} ${webhookUrl}`,
		};
	}
	// Non-HTTP kinds: form is built from the full inputSchema and submits to
	// the kind-agnostic /trigger/ endpoint. (No kinds exist yet; this branch
	// is exercised once cron/mail land.)
	return {
		tenant,
		workflow,
		trigger: descriptor.name,
		kind: descriptor.kind,
		schema: (descriptor.inputSchema ?? { type: "object" }) as object,
		submitUrl: `/trigger/${tenant}/${workflow}/${descriptor.name}`,
		submitMethod: "POST",
	};
}

interface TriggerPageOptions {
	readonly entries: readonly WorkflowEntry[];
	readonly user: string;
	readonly email: string;
	readonly tenants: readonly string[];
	readonly activeTenant: string | undefined;
}

function renderTriggerPage(options: TriggerPageOptions) {
	const { entries, user, email, tenants, activeTenant } = options;
	const cards = entries
		.flatMap(entryToCardDataList)
		.sort((a, b) =>
			`${a.workflow}/${a.trigger}`.localeCompare(`${b.workflow}/${b.trigger}`),
		)
		.map(renderTriggerCard);

	const head = html`  <link rel="stylesheet" href="/static/trigger.css">
  <script src="/static/jedison.js"></script>
  <script defer src="/static/trigger-forms.js"></script>`;

	const content = html`
  <div class="page-header">
    <h1>Trigger</h1>
  </div>

  <div class="trigger-content">
    ${cards.length > 0 ? cards : html`<div class="empty-state">No triggers registered</div>`}
  </div>`;

	return renderLayout(
		{
			title: "Trigger",
			activePath: "/trigger",
			user,
			email,
			head,
			tenants,
			...(activeTenant === undefined ? {} : { activeTenant }),
		},
		content,
	);
}

export type { TriggerCardData };
export { prepareSchema, renderTriggerPage };
