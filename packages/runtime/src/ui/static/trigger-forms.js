/* global Jedison */

class EditorInlineMultiple extends Jedison.EditorMultiple {
	static resolves(schema) {
		return Jedison.EditorMultiple.resolves(schema);
	}
	build() {
		const inst = this.instance;
		this.switcherInput = "select";
		this.embedSwitcher = false;
		this.control = this.theme.getMultipleControl({
			titleHidden: true,
			id: this.getIdFromPath(inst.path),
			switcherOptionValues: inst.switcherOptionValues,
			switcherOptionsLabels: inst.switcherOptionsLabels,
			switcher: "select",
			readOnly: inst.isReadOnly(),
		});
		const header = this.control.header;
		const body = this.control.body;
		const label = document.createElement("label");
		label.textContent = inst.getKey();
		label.classList.add("jedi-title");
		this.control.container.insertBefore(label, header);
		header.style.display = "flex";
		header.style.gap = "8px";
		header.querySelector(".jedi-switcher").style.flex = "0 0 auto";
		body.style.flex = "1 1 0";
		body.style.minWidth = "0";
		header.appendChild(body);
	}
	addEventListeners() {
		if (this.control.switcher?.input) {
			this.control.switcher.input.addEventListener("change", () => {
				const idx = Number(this.control.switcher.input.value);
				this.instance.switchInstance(idx, undefined, "user");
			});
		}
	}
	// biome-ignore lint/style/useNamingConvention: Jedison API requires this method name
	refreshUI() {
		this.refreshDisabledState();
		this.control.childrenSlot.innerHTML = "";
		const child = this.instance.activeInstance;
		if (child?.ui) {
			const cc = child.ui.control;
			if (cc.label) {
				cc.label.style.display = "none";
			}
			cc.container.style.margin = "0";
			this.control.childrenSlot.appendChild(cc.container);
		}
	}
}

function initForm(details) {
	if (!details.open || details._jedison) {
		return;
	}
	const script = details.querySelector('script[type="application/json"]');
	const schema = JSON.parse(script.textContent);
	const container = details.querySelector(".form-container");
	details._jedison = new Jedison.Create({
		container,
		theme: new Jedison.Theme(),
		customEditors: [EditorInlineMultiple],
		schema,
		showErrors: "never",
	});
	const props = schema.properties || {};
	const required = (schema.required || []).filter((key) => !props[key]?.anyOf);
	for (const key of required) {
		const el = container.querySelector(`[data-path="#/${key}"]`);
		if (el) {
			el.classList.add("jedi-required");
		}
	}
}

const HTML_ENTITIES = { "<": "&lt;", ">": "&gt;", "&": "&amp;" };

function renderBanner(ok, message) {
	const cls = ok ? "success" : "error";
	const safe = String(message).replace(/[<>&]/g, (c) => HTML_ENTITIES[c] ?? c);
	return `<div class="banner ${cls}">${safe}</div>`;
}

function submitTrigger(btn) {
	const details = btn.closest(".trigger-details");
	const jedison = details._jedison;
	if (!jedison) {
		return;
	}
	const formValue = jedison.getValue();
	const url = btn.dataset.triggerUrl;
	const method = btn.dataset.triggerMethod || "POST";
	const target = details.querySelector(".banner-target");

	// The form renders a composite schema (body + headers + url + method +
	// params). Extract the sub-fields and build the fetch call.
	const requestBody = formValue.body;
	const extraHeaders = formValue.headers || {};
	const headers = {
		"Content-Type": "application/json",
		...extraHeaders,
	};

	fetch(url, {
		method,
		headers,
		body: JSON.stringify(requestBody),
	})
		.then(async (r) => {
			const text = await r.text();
			if (r.ok) {
				target.innerHTML = renderBanner(true, text || `OK (${r.status})`);
			} else {
				target.innerHTML = renderBanner(false, text || `HTTP ${r.status}`);
			}
		})
		.catch((err) => {
			target.innerHTML = renderBanner(false, err.message || String(err));
		});
}

document.addEventListener("DOMContentLoaded", () => {
	for (const details of document.querySelectorAll(".trigger-details")) {
		details.addEventListener("toggle", () => {
			initForm(details);
		});
	}
	for (const btn of document.querySelectorAll(
		".submit-btn[data-trigger-url]",
	)) {
		btn.addEventListener("click", () => {
			submitTrigger(btn);
		});
	}
});
