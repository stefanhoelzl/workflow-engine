// Shared result-dialog primitive. Depends on the DOM and on the shared JSON
// tree (`window.wfeRenderJsonTree`, defined by `/static/json-tree.js`) which
// owns the per-tree copy-to-clipboard control. Other /static/*.js modules
// reuse it via window.showResult / window.showResultBlocks so no script
// ordering or globals are required beyond "load result-dialog.js after
// json-tree.js."
//
// Three-state outcome keyed on HTTP status class — kind-agnostic so any
// trigger backend that honours the status contract (2xx = ok, 4xx = client,
// 5xx/network = server) picks up the correct visual treatment automatically:
//   2xx → --success (green)
//   4xx → --warn    (amber)
//   5xx / null/network → --error (red)
//
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: IIFE keeps the block builder, dialog singleton, and two show* entry points in one closure — the alternative (separate module-level helpers) would leak private state to the global scope on a no-module-loader setup.
(() => {
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

		// JSON renders via the shared collapsible tree (json-tree.js), which
		// owns the per-tree copy-to-clipboard control. Falls back to
		// <pre>+JSON.stringify if the renderer hasn't loaded yet (test-only
		// path; the fallback intentionally has no copy button).
		const body = document.createElement("div");
		body.classList.add("trigger-result-body");
		if (typeof window.wfeRenderJsonTree === "function") {
			body.appendChild(window.wfeRenderJsonTree(block.payload));
		} else {
			const pre = document.createElement("pre");
			pre.textContent = JSON.stringify(block.payload, null, 2);
			body.appendChild(pre);
		}
		codeWrap.appendChild(body);

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
