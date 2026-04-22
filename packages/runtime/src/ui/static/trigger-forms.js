/* global Jedison */

// Dialog helpers (getResultDialog, showResult, showResultBlocks) live in
// /static/result-dialog.js and attach to window so this module — which carries
// Jedison-dependent code — doesn't need to load on pages without Jedison.

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
		this.control.container.classList.add("jedi-inline-multiple");
		this.control.header.classList.add("jedi-inline-multiple__header");
		this.control.body.classList.add("jedi-inline-multiple__body");
		const label = document.createElement("label");
		label.textContent = inst.getKey();
		label.classList.add("jedi-title");
		this.control.container.insertBefore(label, this.control.header);
		this.control.header.appendChild(this.control.body);
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
			this.control.childrenSlot.appendChild(child.ui.control.container);
		}
	}
}

// Inline theme: make the quick-add-property slot render inline instead of as a
// modal <dialog>. The slot duck-types the <dialog> API (open/showModal/close)
// so Jedison's built-in handlers keep working untouched.
class InlineTheme extends Jedison.Theme {
	getQuickAddPropertySlot(config) {
		const slot = document.createElement("div");
		slot.classList.add("jedi-quick-add-property-slot");
		slot.setAttribute("id", config.id);
		slot.hidden = true;
		let isOpen = false;
		Object.defineProperty(slot, "open", {
			get: () => isOpen,
			set: (value) => {
				isOpen = Boolean(value);
				slot.hidden = !isOpen;
			},
		});
		slot.showModal = () => {
			slot.open = true;
		};
		slot.close = () => {
			slot.open = false;
		};
		slot.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				slot.close();
				event.preventDefault();
			} else if (event.key === "Enter") {
				const btn = slot.querySelector(".jedi-add-property-btn");
				if (btn) {
					btn.click();
					event.preventDefault();
				}
			}
		});
		return slot;
	}
	getQuickAddPropertyToggle(config) {
		const toggle = super.getQuickAddPropertyToggle(config);
		toggle.addEventListener("click", () => {
			if (config.propertiesContainer.open) {
				const input = config.propertiesContainer.querySelector("input");
				input?.focus();
			}
		});
		return toggle;
	}
}

function setButtonText(btn, text) {
	const span = btn.querySelector("span");
	if (span) {
		span.textContent = ` ${text}`;
	} else {
		btn.textContent = text;
	}
}

function relocateAddPropertySlots(container) {
	// Jedison places the quick-add-property slot as a sibling of the object's
	// fieldset, which puts it visually outside the field. Move each slot into
	// the fieldset body and relabel both the toggle and confirm buttons to
	// "Add <field name>".
	for (const slot of container.querySelectorAll(
		".jedi-quick-add-property-slot",
	)) {
		const objectContainer = slot.parentElement;
		if (!objectContainer) {
			continue;
		}
		const fieldset = objectContainer.querySelector(":scope > fieldset");
		const body = fieldset?.querySelector(
			":scope > .jedi-collapse > .jedi-editor-card-body",
		);
		const legend = fieldset?.querySelector(
			":scope > .jedi-editor-legend .jedi-legend",
		);
		const fieldName = legend?.textContent?.trim();
		if (fieldName) {
			const label = `Add ${fieldName}`;
			const toggle = fieldset?.querySelector(
				":scope > .jedi-editor-legend .jedi-quick-add-property-toggle",
			);
			if (toggle) {
				setButtonText(toggle, label);
			}
			const confirmBtn = slot.querySelector(".jedi-add-property-btn");
			if (confirmBtn) {
				setButtonText(confirmBtn, label);
			}
		}
		if (body) {
			body.appendChild(slot);
		}
	}
}

function isAdditionalProperty(jedison, path) {
	const instance = jedison.getInstance(path);
	if (!instance) {
		return false;
	}
	let parent = instance.parent;
	while (parent && parent.schema?.type !== "object") {
		parent = parent.parent;
	}
	if (!parent) {
		return false;
	}
	const declared = parent.schema?.properties || {};
	return !(instance.getKey() in declared);
}

function deletePropertyAt(jedison, path) {
	if (!path.startsWith("#/")) {
		return;
	}
	const segments = path.slice(2).split("/");
	const key = segments.pop();
	if (key === undefined) {
		return;
	}
	const value = structuredClone(jedison.getValue() ?? {});
	let obj = value;
	for (const seg of segments) {
		if (obj == null || typeof obj !== "object") {
			return;
		}
		obj = obj[seg];
	}
	if (obj == null || typeof obj !== "object") {
		return;
	}
	delete obj[key];
	jedison.setValue(value);
}

function addDeleteButtons(container, jedison) {
	for (const editor of container.querySelectorAll("[data-path]")) {
		const path = editor.getAttribute("data-path");
		if (!path || path === "#") {
			continue;
		}
		if (!isAdditionalProperty(jedison, path)) {
			continue;
		}
		const input = editor.querySelector(
			":scope > input, :scope > select, :scope > textarea",
		);
		if (!input) {
			continue;
		}
		if (input.parentElement?.classList.contains("jedi-input-row")) {
			continue;
		}
		const row = document.createElement("div");
		row.classList.add("jedi-input-row");
		input.parentNode.insertBefore(row, input);
		row.appendChild(input);
		const btn = document.createElement("button");
		btn.type = "button";
		btn.classList.add("jedi-delete-property-btn");
		btn.setAttribute("aria-label", "Delete property");
		btn.textContent = "×";
		btn.addEventListener("click", () => {
			deletePropertyAt(jedison, path);
		});
		row.appendChild(btn);
	}
}

function initForm(details) {
	if (!details.open || details._jedison) {
		return;
	}
	// Cards for triggers with no user-settable inputs render without a
	// form-container; nothing to initialize. Submit will post `{}`.
	const container = details.querySelector(".form-container");
	if (!container) {
		return;
	}
	const script = details.querySelector('script[type="application/json"]');
	const schema = JSON.parse(script.textContent);
	const jedison = new Jedison.Create({
		container,
		theme: new InlineTheme(),
		customEditors: [EditorInlineMultiple],
		schema,
		showErrors: "never",
	});
	details._jedison = jedison;
	const props = schema.properties || {};
	const required = (schema.required || []).filter((key) => !props[key]?.anyOf);
	for (const key of required) {
		const el = container.querySelector(`[data-path="#/${key}"]`);
		if (el) {
			el.classList.add("jedi-required");
		}
	}
	relocateAddPropertySlots(container);
	addDeleteButtons(container, jedison);
	const observer = new MutationObserver(() => {
		addDeleteButtons(container, jedison);
	});
	observer.observe(container, { childList: true, subtree: true });
}

function buildResult(response, bodyText) {
	const headers = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	let body;
	if (bodyText === "") {
		body = null;
	} else {
		try {
			body = JSON.parse(bodyText);
		} catch {
			body = bodyText;
		}
	}
	return { status: response.status, headers, body };
}

function setLoading(btn, loading) {
	const label = btn.querySelector(".submit-btn-label");
	if (loading) {
		btn.disabled = true;
		btn.classList.add("submit-btn--loading");
		if (label) {
			btn.dataset.previousLabel = label.textContent;
			label.textContent = "Submitting…";
		}
	} else {
		btn.disabled = false;
		btn.classList.remove("submit-btn--loading");
		if (label && btn.dataset.previousLabel) {
			label.textContent = btn.dataset.previousLabel;
			delete btn.dataset.previousLabel;
		}
	}
}

function submitTrigger(btn) {
	const details = btn.closest(".trigger-details");
	const jedison = details?._jedison;
	const url = btn.dataset.triggerUrl;
	const method = btn.dataset.triggerMethod || "POST";

	// The form's JSON Schema is the wire-format for the submission. When
	// the trigger's schema has no user-settable fields the card is rendered
	// without a form container and no Jedison instance exists — we still
	// POST an empty object so the dispatch path is identical.
	const formValue = jedison ? jedison.getValue() : {};

	setLoading(btn, true);

	fetch(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(formValue),
	})
		.then(async (r) => {
			const text = await r.text();
			setLoading(btn, false);
			window.showResult(buildResult(r, text));
		})
		.catch((err) => {
			setLoading(btn, false);
			window.showResultNetworkError(err.message || String(err));
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
