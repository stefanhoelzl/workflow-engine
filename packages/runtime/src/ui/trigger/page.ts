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
	return html`<details class="event-details" ontoggle="initForm(this)">
      <summary class="event-summary">
        <span class="event-name">${name}</span>
      </summary>
      <div class="event-body">
        <div class="form-container"></div>
        <div class="banner-target"></div>
        <button type="button" class="submit-btn" onclick="submitEvent(this, '${name}')">Submit</button>
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

	const head = html`  <script src="/static/jedison.js"></script>
  <script src="/static/trigger-forms.js"></script>
  <style>
    .trigger-content {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    .event-details {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 8px;
      overflow: hidden;
      transition: box-shadow 0.15s ease;
    }

    .event-details:hover {
      box-shadow: var(--shadow);
    }

    .event-details[open] {
      box-shadow: var(--shadow);
    }

    .event-summary {
      padding: 14px 16px;
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .event-summary::-webkit-details-marker { display: none; }

    .event-summary::before {
      content: "\\25B6";
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.2s ease;
    }

    .event-details[open] > .event-summary::before {
      transform: rotate(90deg);
    }

    .event-name {
      font-weight: 600;
      font-size: 14px;
      font-family: var(--font-mono);
    }

    .event-body {
      border-top: 1px solid var(--border);
      padding: 16px;
      background: var(--bg-surface);
    }

    .form-container {
      margin-bottom: 12px;
    }

    /* Jedison base theme overrides */
    .form-container input[type="text"],
    .form-container input[type="number"],
    .form-container input[type="email"],
    .form-container input[type="url"],
    .form-container input[type="password"],
    .form-container select,
    .form-container textarea {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.5;
      outline: none;
      transition: border-color 0.15s ease;
    }

    .form-container input:focus,
    .form-container select:focus,
    .form-container textarea:focus {
      border-color: var(--accent);
    }

    .form-container label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 4px;
      font-family: var(--font-mono);
    }

    .jedi-required > label::after {
      content: " *";
      color: var(--red);
    }

    .form-container fieldset {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 8px;
    }

    .form-container legend {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      padding: 0 4px;
    }

    .form-container .jedi-editor-container {
      margin-bottom: 8px;
    }

    .form-container input[type="checkbox"] {
      accent-color: var(--accent);
    }
  </style>`;

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
