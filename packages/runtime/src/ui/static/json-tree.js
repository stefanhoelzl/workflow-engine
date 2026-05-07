/* global Alpine */

// Shared Alpine components for the /queue surface and the migrated trigger
// result dialog (`result-dialog.js`). All components register via
// `Alpine.data(name, factory)` (CSP-clean — no inline `x-data="{...}"`
// literals, no inline scripts).
//
// Three components:
//   wfeJsonTree   — interactive collapsible JSON tree. Reads its initial
//                    value from the host element's data-json attribute,
//                    renders into a child [data-json-tree-mount] (or the
//                    host if that hook is absent). Default state: fully
//                    expanded.
//   wfeQueueCard  — <details> wrapper that lazy-fetches an items HTML
//                    fragment (server-rendered) into [data-queue-items] on
//                    first expand. Idempotent: subsequent expansions do
//                    not refetch.
//   wfeLoadMore   — placeholder; load-more activation is delegated by
//                    wfeQueueCard via event listener on the card root.
//
// All three are CSP-friendly: every binding lives in this module, registered
// via Alpine.data + manual `addEventListener` calls. No inline handlers.

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: IIFE keeps tree-rendering helpers, two Alpine factories, fragment-append helper and registration in one closure — the alternative (separate module-level helpers) leaks private state to the global scope on a no-module-loader setup, identical pattern to result-dialog.js
(() => {
	const PrimitiveClass = {
		string: "json-tree-string",
		number: "json-tree-number",
		boolean: "json-tree-boolean",
		null: "json-tree-null",
		undefined: "json-tree-undefined",
	};

	function classifyPrimitive(value) {
		if (value === null) {
			return "null";
		}
		const t = typeof value;
		if (t === "string" || t === "number" || t === "boolean") {
			return t;
		}
		return "undefined";
	}

	function renderPrimitive(value) {
		const span = document.createElement("span");
		const kind = classifyPrimitive(value);
		span.classList.add("json-tree-primitive", PrimitiveClass[kind]);
		if (kind === "string") {
			span.textContent = JSON.stringify(value);
		} else if (kind === "null" || kind === "undefined") {
			span.textContent = "null";
		} else {
			span.textContent = String(value);
		}
		return span;
	}

	function renderKey(key) {
		const span = document.createElement("span");
		span.classList.add("json-tree-key");
		span.textContent = `${JSON.stringify(key)}: `;
		return span;
	}

	function renderPunct(text, extraClass) {
		const span = document.createElement("span");
		span.classList.add("json-tree-punct");
		if (extraClass) {
			span.classList.add(extraClass);
		}
		span.textContent = text;
		return span;
	}

	// Render the tree as a flat sequence of rows whose horizontal indent is
	// driven purely by `data-depth` (CSS picks the per-depth padding-left).
	// This avoids the previous problem where a nested container, rendered
	// inline next to its key, made the body indent relative to where the key
	// ends — producing an indent that grew by `len(key) + 2` per level
	// instead of a fixed two-space step.
	//
	// Structure for an object/array container (key omitted for arrays at the
	// root):
	//   <div class="json-tree-container" data-collapsed="false">
	//     <div class="json-tree-row json-tree-open-row" data-depth="N">
	//       ▾ <key>: { <hint> <}-inline> ,?
	//     </div>
	//     <div class="json-tree-body">
	//       …rows + nested containers at depth N+1…
	//     </div>
	//     <div class="json-tree-row json-tree-close-block" data-depth="N">
	//       } ,?
	//     </div>
	//   </div>
	// CSS hides the inline-close + hint when expanded, hides the body +
	// close-block when collapsed, so the same DOM serves both states.

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: single recursive emitter builds the open row, body, close row, and toggle handler — the alternative (separate emit-open / emit-body / emit-close helpers) fragments the structure with no readability gain
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: same — branches handle empty container, primitive child, container child; flattening hides the parallel structure
	// biome-ignore lint/complexity/useMaxParams: positional args mirror the recursion shape (parent, value, depth, key, hasNext, isArray); folding into an options object hurts readability of the recursion call sites
	function appendContainer(parent, value, depth, key, hasNext, isArray) {
		const open = isArray ? "[" : "{";
		const close = isArray ? "]" : "}";
		const entries = isArray
			? value.map((v, i) => [i, v])
			: Object.entries(value);

		const container = document.createElement("div");
		container.classList.add("json-tree-container");
		container.setAttribute("data-collapsed", "false");

		const openRow = document.createElement("div");
		openRow.classList.add("json-tree-row", "json-tree-open-row");
		openRow.setAttribute("data-depth", String(depth));

		const button = document.createElement("button");
		button.type = "button";
		button.classList.add("json-tree-disclosure");
		button.setAttribute("aria-expanded", "true");
		button.setAttribute(
			"aria-label",
			`Collapse ${isArray ? "array" : "object"}`,
		);
		button.textContent = "▾";
		openRow.appendChild(button);

		if (key !== undefined) {
			openRow.appendChild(renderKey(String(key)));
		}
		openRow.appendChild(renderPunct(open));

		if (entries.length === 0) {
			openRow.appendChild(renderPunct(close));
			if (hasNext) {
				openRow.appendChild(renderPunct(","));
			}
			container.appendChild(openRow);
			parent.appendChild(container);
			return;
		}

		const hint = document.createElement("span");
		hint.classList.add("json-tree-collapsed-hint");
		hint.textContent = `${String(entries.length)} ${isArray ? "items" : "keys"}`;
		openRow.appendChild(hint);
		openRow.appendChild(renderPunct(close, "json-tree-close-inline"));
		if (hasNext) {
			openRow.appendChild(renderPunct(",", "json-tree-trailing-comma"));
		}
		container.appendChild(openRow);

		const body = document.createElement("div");
		body.classList.add("json-tree-body");
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const childKey = isArray ? undefined : String(entry[0]);
			const childValue = entry[1];
			const childHasNext = i < entries.length - 1;
			appendValue(body, childValue, depth + 1, childKey, childHasNext);
		}
		container.appendChild(body);

		const closeRow = document.createElement("div");
		closeRow.classList.add("json-tree-row", "json-tree-close-block");
		closeRow.setAttribute("data-depth", String(depth));
		closeRow.appendChild(renderPunct(close));
		if (hasNext) {
			closeRow.appendChild(renderPunct(","));
		}
		container.appendChild(closeRow);

		button.addEventListener("click", () => {
			const collapsed = container.getAttribute("data-collapsed") === "true";
			const next = !collapsed;
			container.setAttribute("data-collapsed", next ? "true" : "false");
			button.setAttribute("aria-expanded", next ? "false" : "true");
			button.textContent = next ? "▸" : "▾";
			button.setAttribute(
				"aria-label",
				`${next ? "Expand" : "Collapse"} ${isArray ? "array" : "object"}`,
			);
		});

		parent.appendChild(container);
	}

	// biome-ignore lint/complexity/useMaxParams: positional args mirror appendContainer's recursion shape (parent, value, depth, key, hasNext); folding hurts call-site readability
	function appendPrimitiveRow(parent, value, depth, key, hasNext) {
		const row = document.createElement("div");
		row.classList.add("json-tree-row");
		row.setAttribute("data-depth", String(depth));
		if (key !== undefined) {
			row.appendChild(renderKey(String(key)));
		}
		row.appendChild(renderPrimitive(value));
		if (hasNext) {
			row.appendChild(renderPunct(","));
		}
		parent.appendChild(row);
	}

	// biome-ignore lint/complexity/useMaxParams: positional args mirror the recursive emitter signature; folding hurts call-site readability
	function appendValue(parent, value, depth, key, hasNext) {
		if (Array.isArray(value)) {
			appendContainer(parent, value, depth, key, hasNext, true);
			return;
		}
		if (value !== null && typeof value === "object") {
			appendContainer(parent, value, depth, key, hasNext, false);
			return;
		}
		appendPrimitiveRow(parent, value, depth, key, hasNext);
	}

	// Public render entry point. Returns the root DOM node.
	function renderJson(value) {
		const wrap = document.createElement("div");
		wrap.classList.add("json-tree");
		appendValue(wrap, value, 0, undefined, false);
		return wrap;
	}

	function decodeJsonAttr(el) {
		const raw = el.getAttribute("data-json");
		if (raw === null) {
			return;
		}
		try {
			return JSON.parse(raw);
		} catch {
			return;
		}
	}

	function jsonTreeFactory() {
		return {
			init() {
				const host = this.$el;
				const value = decodeJsonAttr(host);
				const mount = host.querySelector("[data-json-tree-mount]") || host;
				mount.replaceChildren(renderJson(value));
			},
		};
	}

	// Lazy fetch of the items fragment on first expand. The card host element
	// is a <details> with `data-queue-items-url` and a child
	// [data-queue-items] container.
	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory wraps the toggle handler + delegated load-more click handler in one closure for shared state (loaded flag) — splitting requires reintroducing the state externally
	function queueCardFactory() {
		return {
			loaded: false,
			// biome-ignore lint/complexity/noExcessiveLinesPerFunction: same — both event listeners and their fetch+append flows live in one init() to share the parent <details> reference
			init() {
				const details = this.$el;
				const onToggle = () => {
					if (this.loaded || !details.open) {
						return;
					}
					this.loaded = true;
					const url = details.getAttribute("data-queue-items-url");
					if (!url) {
						return;
					}
					const target = details.querySelector("[data-queue-items]");
					if (!target) {
						return;
					}
					target.setAttribute("data-loading", "true");
					fetch(url, { credentials: "same-origin" })
						.then((res) => {
							if (!res.ok) {
								throw new Error(`status ${String(res.status)}`);
							}
							return res.text();
						})
						.then((html) => {
							target.removeAttribute("data-loading");
							appendFragment(target, html);
						})
						.catch((err) => {
							target.removeAttribute("data-loading");
							const errorEl = document.createElement("div");
							errorEl.classList.add("queue-load-error");
							errorEl.textContent = `Failed to load items: ${err.message}`;
							target.appendChild(errorEl);
						});
				};
				details.addEventListener("toggle", onToggle);
				// Delegated load-more handler. Each load-more button replaces
				// itself with the next fragment.
				details.addEventListener("click", (event) => {
					const target = event.target;
					if (
						!(
							target instanceof HTMLElement &&
							target.hasAttribute("data-queue-load-more")
						)
					) {
						return;
					}
					const url = target.getAttribute("data-queue-items-url");
					if (!url) {
						return;
					}
					target.setAttribute("disabled", "true");
					fetch(url, { credentials: "same-origin" })
						.then((res) => {
							if (!res.ok) {
								throw new Error(`status ${String(res.status)}`);
							}
							return res.text();
						})
						.then((html) => {
							const container = target.parentElement;
							target.remove();
							if (container) {
								appendFragment(container, html);
							}
						})
						.catch((err) => {
							target.removeAttribute("disabled");
							const errorEl = document.createElement("div");
							errorEl.classList.add("queue-load-error");
							errorEl.textContent = `Failed to load more: ${err.message}`;
							target.parentElement?.appendChild(errorEl);
						});
				});
			},
		};
	}

	// Append a server-rendered HTML fragment to a target node and process any
	// `x-data` Alpine bindings inside it (Alpine does not auto-scan
	// imperatively-injected nodes; `Alpine.initTree` walks the new subtree).
	function appendFragment(target, html) {
		const tpl = document.createElement("template");
		tpl.innerHTML = html;
		const fragment = tpl.content;
		const nodes = Array.from(fragment.childNodes);
		for (const node of nodes) {
			target.appendChild(node);
			if (node.nodeType === 1 && window.Alpine?.initTree) {
				window.Alpine.initTree(node);
			}
		}
	}

	function register() {
		if (!window.Alpine) {
			return false;
		}
		window.Alpine.data("wfeJsonTree", jsonTreeFactory);
		window.Alpine.data("wfeQueueCard", queueCardFactory);
		return true;
	}

	// Expose the imperative renderer so result-dialog.js (and any other
	// non-Alpine consumer) can mount a JSON tree without going through
	// Alpine.data.
	window.wfeRenderJsonTree = renderJson;

	// Bridge htmx swaps into Alpine. The invocations row expands via
	// `hx-get`/`hx-swap="innerHTML"` and may inject markup carrying
	// `x-data="wfeJsonTree"` (e.g. the event-detail fragment). Alpine does
	// not auto-walk htmx-swapped subtrees, so we trigger `initTree` on the
	// swap target here. Idempotent — running on already-initialised nodes
	// is a no-op for Alpine.
	function initSwapTarget(event) {
		const target = event?.detail?.target ?? event?.target;
		if (target && target.nodeType === 1 && window.Alpine?.initTree) {
			window.Alpine.initTree(target);
		}
	}
	document.addEventListener("htmx:afterSwap", initSwapTarget);

	// Alpine initialises on `alpine:init`; if we load after that event has
	// already fired, register synchronously.
	if (!register()) {
		document.addEventListener("alpine:init", register, { once: true });
	}
})();
