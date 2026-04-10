import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import type { EventSource } from "../event-source.js";
import type { Middleware } from "../triggers/http.js";
import { PayloadValidationError } from "../context/errors.js";
import { renderLayout } from "../views/layout.js";

const require = createRequire(import.meta.url);
const jedisonJs = readFileSync(require.resolve("jedison/browser"), "utf-8");

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

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
			if (!v.title && typeof v.type === "string") { v.title = v.type; }
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

function escapeHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSuccessBanner(): string {
	return `<div class="banner success">Event emitted</div>`;
}

function renderErrorBanner(eventType: string, issues: { path: string; message: string }[]): string {
	const issueList = issues.length > 0
		? issues.map((i) => `<li><strong>${escapeHtml(i.path || "(root)")}</strong>: ${escapeHtml(i.message)}</li>`).join("")
		: `<li>Invalid payload for event <strong>${escapeHtml(eventType)}</strong></li>`;
	return `<div class="banner error"><ul>${issueList}</ul></div>`;
}

function renderEventDetails(name: string, schema: object): string {
	const schemaJson = JSON.stringify(prepareSchema(schema));
	return `<details class="event-details" ontoggle="initForm(this)">
      <summary class="event-summary">
        <span class="event-name">${escapeHtml(name)}</span>
      </summary>
      <div class="event-body">
        <div class="form-container"></div>
        <div class="banner-target"></div>
        <button type="button" class="submit-btn" onclick="submitEvent(this, '${escapeHtml(name)}')">Submit</button>
      </div>
      <script type="application/json">${schemaJson}</script>
    </details>`;
}

function renderTriggerPage(schemas: Record<string, object>): string {
	const events = Object.entries(schemas)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, schema]) => renderEventDetails(name, schema))
		.join("\n    ");

	const head = `  <script src="/trigger/jedison.js"></script>
  <style>
    .trigger-content {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    .trigger-header {
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(8px);
    }

    .trigger-header h1 {
      font-size: 16px;
      font-weight: 600;
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

    .submit-btn {
      padding: 8px 20px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 600;
      font-family: var(--font);
      cursor: pointer;
      transition: opacity 0.15s ease;
    }

    .submit-btn:hover {
      opacity: 0.9;
    }

    .banner {
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      margin-bottom: 12px;
    }

    .banner.success {
      background: var(--green-bg);
      border: 1px solid var(--green-border);
      color: var(--green);
      font-weight: 600;
    }

    .banner.error {
      background: var(--red-bg);
      border: 1px solid var(--red-border);
      color: var(--red);
    }

    .banner.error ul {
      margin: 0;
      padding-left: 18px;
    }

    .banner.error li {
      margin-bottom: 2px;
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
      font-size: 14px;
    }
  </style>`;

	const content = `
  <div class="trigger-header">
    <h1>Trigger Events</h1>
  </div>

  <div class="trigger-content">
    ${events || '<div class="empty-state">No events defined</div>'}
  </div>

  <script>
    class EditorInlineMultiple extends Jedison.EditorMultiple {
      static resolves(schema) { return Jedison.EditorMultiple.resolves(schema); }
      build() {
        var inst = this.instance;
        this.switcherInput = 'select';
        this.embedSwitcher = false;
        this.control = this.theme.getMultipleControl({
          titleHidden: true,
          id: this.getIdFromPath(inst.path),
          switcherOptionValues: inst.switcherOptionValues,
          switcherOptionsLabels: inst.switcherOptionsLabels,
          switcher: 'select',
          readOnly: inst.isReadOnly()
        });
        var header = this.control.header;
        var body = this.control.body;
        var label = document.createElement('label');
        label.textContent = inst.getKey();
        label.classList.add('jedi-title');
        this.control.container.insertBefore(label, header);
        header.style.display = 'flex';
        header.style.gap = '8px';
        header.querySelector('.jedi-switcher').style.flex = '0 0 auto';
        body.style.flex = '1 1 0';
        body.style.minWidth = '0';
        header.appendChild(body);
      }
      addEventListeners() {
        if (this.control.switcher && this.control.switcher.input) {
          this.control.switcher.input.addEventListener('change', () => {
            var idx = Number(this.control.switcher.input.value);
            this.instance.switchInstance(idx, undefined, 'user');
          });
        }
      }
      refreshUI() {
        this.refreshDisabledState();
        this.control.childrenSlot.innerHTML = '';
        var child = this.instance.activeInstance;
        if (child && child.ui) {
          var cc = child.ui.control;
          if (cc.label) cc.label.style.display = 'none';
          cc.container.style.margin = '0';
          this.control.childrenSlot.appendChild(cc.container);
        }
      }
    }

    function initForm(details) {
      if (!details.open || details._jedison) return;
      var script = details.querySelector('script[type="application/json"]');
      var schema = JSON.parse(script.textContent);
      var container = details.querySelector('.form-container');
      details._jedison = new Jedison.Create({
        container: container,
        theme: new Jedison.Theme(),
        customEditors: [EditorInlineMultiple],
        schema: schema,
        showErrors: 'never'
      });
      var props = schema.properties || {};
      var required = (schema.required || []).filter(function(key) {
        return !props[key] || !props[key].anyOf;
      });
      for (var i = 0; i < required.length; i++) {
        var el = container.querySelector('[data-path="#/' + required[i] + '"]');
        if (el) el.classList.add('jedi-required');
      }
    }

    function submitEvent(btn, eventType) {
      var details = btn.closest('.event-details');
      var jedison = details._jedison;
      if (!jedison) return;
      var target = details.querySelector('.banner-target');
      fetch('/trigger/' + encodeURIComponent(eventType), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jedison.getValue())
      })
      .then(function(r) { return r.text(); })
      .then(function(html) { target.innerHTML = html; });
    }
  </script>`;

	return renderLayout(
		{ title: "Trigger Events", activePath: "/trigger", head },
		content,
	);
}

function triggerMiddleware(
	schemaSource: { readonly jsonSchemas: Record<string, object> },
	source: EventSource,
): Middleware {
	const app = new Hono().basePath("/trigger");

	app.get("/", (c) => c.html(renderTriggerPage(schemaSource.jsonSchemas)));

	app.post("/:eventType", async (c) => {
		const eventType = c.req.param("eventType");

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.html(renderErrorBanner(eventType, [{ path: "", message: "Invalid JSON body" }]));
		}

		try {
			await source.create(eventType, body, "trigger-ui");
		} catch (error) {
			if (error instanceof PayloadValidationError) {
				return c.html(renderErrorBanner(error.eventType, error.issues));
			}
			throw error;
		}

		return c.html(renderSuccessBanner());
	});

	app.get("/jedison.js", (c) =>
		c.body(jedisonJs, {
			headers: {
				"content-type": "application/javascript",
				"cache-control": IMMUTABLE_CACHE,
			},
		}),
	);

	return {
		match: "/trigger/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export { triggerMiddleware, prepareSchema };
