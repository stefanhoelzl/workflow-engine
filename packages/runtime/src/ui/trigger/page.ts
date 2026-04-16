import { html, raw } from "hono/html";
import type { HttpTriggerEntry } from "../../triggers/http.js";
import { renderLayout } from "../layout.js";

// ---------------------------------------------------------------------------
// Trigger UI (v1) — manual-fire form for registered HTTP triggers
// ---------------------------------------------------------------------------
//
// The dashboard's "Trigger" tab renders one collapsible card per registered
// HTTP trigger. Each card embeds the body JSON Schema as an inert JSON
// script tag (jedison on the client picks it up and builds a form).
// Submitting POSTs to the trigger's webhook URL (`/webhooks/<path>` with
// the correct method), i.e. the same public ingress any external caller
// would use — so the trigger UI is a thin UI wrapper over the webhook
// plane and exercises the same validation + executor path.

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

interface TriggerCardData {
	readonly workflow: string;
	readonly trigger: string;
	readonly path: string;
	readonly method: string;
	readonly schema: object;
}

function renderTriggerCard(data: TriggerCardData) {
	const schemaJson = JSON.stringify(prepareSchema(data.schema));
	const webhookUrl = `/webhooks/${data.path}`;
	const cardId = `trigger-${data.workflow}-${data.trigger}`
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.toLowerCase();
	return html`<details class="trigger-details" id="${cardId}">
      <summary class="trigger-summary">
        <span class="trigger-name">${data.workflow} / ${data.trigger}</span>
        <span class="trigger-meta">${data.method} ${webhookUrl}</span>
      </summary>
      <div class="trigger-body">
        <div class="form-container"></div>
        <button
          type="button"
          class="submit-btn"
          data-trigger-url="${webhookUrl}"
          data-trigger-method="${data.method}"
        >Submit</button>
      </div>
      <script type="application/json">${raw(schemaJson)}</script>
    </details>`;
}

function renderTriggerPage(
	triggers: readonly HttpTriggerEntry[],
	user: string,
	email: string,
) {
	const cards = triggers
		.map(
			(entry): TriggerCardData => ({
				workflow: entry.workflow.name,
				trigger: entry.descriptor.name,
				path: entry.descriptor.path,
				method: entry.descriptor.method,
				schema: (entry.schema ?? { type: "object" }) as object,
			}),
		)
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
		{ title: "Trigger", activePath: "/trigger", user, email, head },
		content,
	);
}

export type { TriggerCardData };
export { prepareSchema, renderTriggerPage };
