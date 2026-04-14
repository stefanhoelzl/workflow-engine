import { html, raw } from "hono/html";
import { renderLayout } from "../layout.js";

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

function renderEventDetails(name: string, schema: object) {
	const schemaJson = JSON.stringify(prepareSchema(schema));
	return html`<details class="event-details">
      <summary class="event-summary">
        <span class="event-name">${name}</span>
      </summary>
      <div class="event-body">
        <div class="form-container"></div>
        <div class="banner-target"></div>
        <button type="button" class="submit-btn" data-event-type="${name}">Submit</button>
      </div>
      <script type="application/json">${raw(schemaJson)}</script>
    </details>`;
}

function renderTriggerPage(
	schemas: Record<string, object>,
	user: string,
	email: string,
) {
	const events = Object.entries(schemas)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, schema]) => renderEventDetails(name, schema));

	const head = html`  <link rel="stylesheet" href="/static/trigger.css">
  <script src="/static/jedison.js"></script>
  <script defer src="/static/trigger-forms.js"></script>`;

	const content = html`
  <div class="page-header">
    <h1>Trigger Events</h1>
  </div>

  <div class="trigger-content">
    ${events.length > 0 ? events : html`<div class="empty-state">No events defined</div>`}
  </div>`;

	return renderLayout(
		{ title: "Trigger Events", activePath: "/trigger", user, email, head },
		content,
	);
}

export { prepareSchema, renderTriggerPage };
