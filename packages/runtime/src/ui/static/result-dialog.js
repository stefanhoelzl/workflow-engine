// Shared result-dialog primitive. Standalone — depends only on the DOM and the
// clipboard API. Other /static/*.js modules reuse it via window.showResult /
// window.showResultBlocks so no script ordering or globals are required beyond
// "load result-dialog.js before any consumer."
//
// Three-state outcome keyed on HTTP status class — kind-agnostic so any
// trigger backend that honours the status contract (2xx = ok, 4xx = client,
// 5xx/network = server) picks up the correct visual treatment automatically:
//   2xx → --success (green)
//   4xx → --warn    (amber)
//   5xx / null/network → --error (red)
//
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: IIFE keeps icon builders, block builder, dialog singleton, and two show* entry points in one closure — the alternative (separate module-level helpers) would leak private state to the global scope on a no-module-loader setup.
(() => {
	const CopyFeedbackMs = 2000;
	const SvgNs = "http://www.w3.org/2000/svg";

	// HTTP status-class boundaries (RFC 9110 §15).
	const StatusSuccessMin = 200;
	const StatusSuccessMax = 300;
	const StatusClientErrorMin = 400;
	const StatusClientErrorMax = 500;

	const OutcomeStateClasses = [
		"trigger-result-dialog--success",
		"trigger-result-dialog--warn",
		"trigger-result-dialog--error",
	];

	function createIcon(children) {
		const svg = document.createElementNS(SvgNs, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", "14");
		svg.setAttribute("height", "14");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		for (const [tag, attrs] of children) {
			const el = document.createElementNS(SvgNs, tag);
			for (const [k, v] of Object.entries(attrs)) {
				el.setAttribute(k, v);
			}
			svg.appendChild(el);
		}
		return svg;
	}

	function createCopyIcon() {
		return createIcon([
			["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
			[
				"path",
				{ d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" },
			],
		]);
	}

	function createCheckIcon() {
		return createIcon([["path", { d: "M20 6 9 17l-5-5" }]]);
	}

	function replaceIcon(btn, icon) {
		btn.replaceChildren(icon);
	}

	function buildResultBlock(block) {
		const wrap = document.createElement("div");
		wrap.classList.add("trigger-result-block");
		if (block.label) {
			const heading = document.createElement("h3");
			heading.classList.add("trigger-result-label");
			heading.textContent = block.label;
			wrap.appendChild(heading);
		}
		const codeWrap = document.createElement("div");
		codeWrap.classList.add("trigger-result-code");

		const pre = document.createElement("pre");
		pre.classList.add("trigger-result-body");
		pre.textContent = JSON.stringify(block.payload, null, 2);
		codeWrap.appendChild(pre);

		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.classList.add("trigger-result-copy");
		copyBtn.setAttribute("aria-label", "Copy to clipboard");
		replaceIcon(copyBtn, createCopyIcon());

		// Visually-hidden live region so screen readers hear "Copied" on success
		const live = document.createElement("span");
		live.classList.add("sr-live");
		live.setAttribute("role", "status");
		live.setAttribute("aria-live", "polite");

		copyBtn.addEventListener("click", () => {
			navigator.clipboard.writeText(pre.textContent).then(() => {
				replaceIcon(copyBtn, createCheckIcon());
				copyBtn.classList.add("trigger-result-copy--copied");
				live.textContent = "Copied";
				setTimeout(() => {
					replaceIcon(copyBtn, createCopyIcon());
					copyBtn.classList.remove("trigger-result-copy--copied");
					live.textContent = "";
				}, CopyFeedbackMs);
			});
		});
		codeWrap.appendChild(copyBtn);
		codeWrap.appendChild(live);
		wrap.appendChild(codeWrap);
		return wrap;
	}

	function getResultDialog() {
		let dialog = document.getElementById("trigger-result-dialog");
		if (dialog) {
			return dialog;
		}
		dialog = document.createElement("dialog");
		dialog.id = "trigger-result-dialog";
		dialog.classList.add("trigger-result-dialog");

		const statusBar = document.createElement("div");
		statusBar.classList.add("trigger-result-status");
		dialog.appendChild(statusBar);

		const blocksContainer = document.createElement("div");
		blocksContainer.classList.add("trigger-result-blocks");
		dialog.appendChild(blocksContainer);

		const closeBtn = document.createElement("button");
		closeBtn.type = "button";
		closeBtn.classList.add("trigger-result-close");
		closeBtn.textContent = "Close";
		closeBtn.addEventListener("click", () => {
			dialog.close();
		});
		dialog.appendChild(closeBtn);

		// Click outside the dialog content (on the backdrop) also closes it.
		dialog.addEventListener("click", (event) => {
			if (event.target === dialog) {
				dialog.close();
			}
		});

		document.body.appendChild(dialog);
		return dialog;
	}

	// Status → visual state class + outcome word. `null` = network failure.
	function pickOutcome(status) {
		if (
			status != null &&
			status >= StatusSuccessMin &&
			status < StatusSuccessMax
		) {
			return {
				cls: "trigger-result-dialog--success",
				word: "Success",
				icon: "✓",
			};
		}
		if (
			status != null &&
			status >= StatusClientErrorMin &&
			status < StatusClientErrorMax
		) {
			return { cls: "trigger-result-dialog--warn", word: "Failed", icon: "⚠" };
		}
		return { cls: "trigger-result-dialog--error", word: "Error", icon: "✗" };
	}

	function renderStatusBar(dialog, status, body) {
		const bar = dialog.querySelector(".trigger-result-status");
		bar.replaceChildren();
		const outcome = pickOutcome(status);
		const main = document.createElement("span");
		main.textContent = `${outcome.icon} ${outcome.word}`;
		bar.appendChild(main);

		if (body && typeof body === "object" && typeof body.error === "string") {
			const detail = document.createElement("span");
			detail.classList.add("trigger-result-status-detail");
			detail.textContent = body.error;
			bar.appendChild(detail);
		}

		for (const cls of OutcomeStateClasses) {
			dialog.classList.remove(cls);
		}
		dialog.classList.add(outcome.cls);
	}

	function showResultBlocks(blocks, status, body) {
		const dialog = getResultDialog();
		renderStatusBar(dialog, status, body);
		const container = dialog.querySelector(".trigger-result-blocks");
		container.replaceChildren(...blocks.map(buildResultBlock));
		dialog.showModal();
	}

	// Convenience: open the dialog with the full { status, headers, body }
	// result object built by trigger-forms.js (one block, labelled null).
	function showResult(result) {
		showResultBlocks(
			[{ label: null, payload: result }],
			result.status,
			result.body,
		);
	}

	// Convenience: network / fetch rejection path.
	function showResultNetworkError(message) {
		showResultBlocks([{ label: null, payload: { error: message } }], null, {
			error: message,
		});
	}

	window.showResult = showResult;
	window.showResultBlocks = showResultBlocks;
	window.showResultNetworkError = showResultNetworkError;
})();
