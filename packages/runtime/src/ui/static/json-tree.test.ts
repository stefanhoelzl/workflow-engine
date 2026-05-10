import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the static `json-tree.js` module inside a linkedom-backed window so
// we can assert on its DOM output without spinning up a real browser.
//
// The script is a self-IIFE that:
//   - registers Alpine.data("wfeJsonTree", …) and Alpine.data("wfeQueueCard",…)
//     when window.Alpine is present (or on the `alpine:init` event later)
//   - exposes `window.wfeRenderJsonTree(value): HTMLElement` — the imperative
//     entry point used by `result-dialog.js` post-migration. Tests target
//     this entry point.

const SCRIPT_PATH = fileURLToPath(new URL("./json-tree.js", import.meta.url));
const SCRIPT_SRC = readFileSync(SCRIPT_PATH, "utf8");

interface Bag {
	window: typeof globalThis & {
		wfeRenderJsonTree?: (value: unknown) => HTMLElement;
	};
	document: Document;
	clipboardWrites: string[];
}

function bootScript(): Bag {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	// Provide a fetch shim — the script doesn't use it at module load, but the
	// queueCardFactory references it, and Alpine isn't booted here so Alpine
	// component registration is a no-op (the `if (!register())` branch
	// re-arms registration on `alpine:init`, which we don't fire).
	(window as unknown as Record<string, unknown>).fetch = async () =>
		new Response("");
	const clipboardWrites: string[] = [];
	// linkedom's `window.navigator` is read-only, so we can't replace it on the
	// host window. Instead we pass a stand-in `navigator` as a third argument
	// to the IIFE wrapper — the script body references `navigator.clipboard`
	// directly, so the parameter shadows the host global only for its scope.
	const navigator = {
		clipboard: {
			writeText: (text: string) => {
				clipboardWrites.push(text);
				return Promise.resolve();
			},
		},
	};
	new Function("window", "document", "navigator", SCRIPT_SRC)(
		window,
		window.document,
		navigator,
	);
	return {
		window: window as Bag["window"],
		document: window.document,
		clipboardWrites,
	};
}

let bag: Bag;
beforeEach(() => {
	bag = bootScript();
});

describe("wfeRenderJsonTree — imperative renderer", () => {
	it("exposes window.wfeRenderJsonTree", () => {
		expect(typeof bag.window.wfeRenderJsonTree).toBe("function");
	});

	it("renders a primitive number", () => {
		const root = bag.window.wfeRenderJsonTree?.(42);
		expect(root?.textContent).toBe("42");
		expect(root?.querySelector(".json-tree-number")).toBeTruthy();
	});

	it("renders a string with quotes", () => {
		const root = bag.window.wfeRenderJsonTree?.("hello");
		expect(root?.textContent).toBe('"hello"');
		expect(root?.querySelector(".json-tree-string")).toBeTruthy();
	});

	it("renders null as italic null", () => {
		const root = bag.window.wfeRenderJsonTree?.(null);
		expect(root?.querySelector(".json-tree-null")?.textContent).toBe("null");
	});

	it("renders an object fully expanded by default", () => {
		const root = bag.window.wfeRenderJsonTree?.({ a: 1, b: { c: 2 } });
		const containers = root?.querySelectorAll(".json-tree-container") ?? [];
		expect(containers.length).toBeGreaterThan(0);
		for (const c of containers) {
			expect(c.getAttribute("data-collapsed")).toBe("false");
		}
		// All keys visible
		expect(root?.textContent).toContain('"a"');
		expect(root?.textContent).toContain('"b"');
		expect(root?.textContent).toContain('"c"');
	});

	it("renders disclosure as a button with aria-expanded='true' by default", () => {
		const root = bag.window.wfeRenderJsonTree?.({ a: 1 });
		const btn = root?.querySelector("button.json-tree-disclosure");
		expect(btn?.getAttribute("aria-expanded")).toBe("true");
		expect(btn?.tagName.toLowerCase()).toBe("button");
		expect(btn?.getAttribute("type")).toBe("button");
	});

	it("collapses nested children when disclosure is clicked", () => {
		const root = bag.window.wfeRenderJsonTree?.({ a: 1, b: { c: 2 } });
		// Find the disclosure button on the *nested* container (key b)
		const containers = root?.querySelectorAll(
			".json-tree-container",
		) as unknown as HTMLElement[];
		// Outer is index 0; nested object container is one of the descendants
		const nested = Array.from(containers).filter((c) => c !== containers[0])[0];
		const btn = nested?.querySelector(
			"button.json-tree-disclosure",
		) as HTMLButtonElement;
		expect(nested?.getAttribute("data-collapsed")).toBe("false");

		btn.dispatchEvent(new bag.window.Event("click", { bubbles: true }));

		expect(nested?.getAttribute("data-collapsed")).toBe("true");
		expect(btn.getAttribute("aria-expanded")).toBe("false");

		btn.dispatchEvent(new bag.window.Event("click", { bubbles: true }));
		expect(nested?.getAttribute("data-collapsed")).toBe("false");
		expect(btn.getAttribute("aria-expanded")).toBe("true");
	});

	it("renders an empty array without a load-more / hint", () => {
		const root = bag.window.wfeRenderJsonTree?.([]);
		expect(root?.textContent).toContain("[]");
		expect(root?.querySelector(".json-tree-collapsed-hint")).toBeNull();
	});
});

describe("wfeRenderJsonTree — copy-to-clipboard control", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function flushPromises(): Promise<void> {
		return new Promise((resolve) => {
			setImmediate(resolve);
		});
	}

	it("renders a copy button and an sr-live region as children of the tree root", () => {
		const root = bag.window.wfeRenderJsonTree?.({ a: 1 });
		const button = root?.querySelector("button.json-tree-copy");
		expect(button).toBeTruthy();
		expect(button?.getAttribute("type")).toBe("button");
		expect(button?.getAttribute("aria-label")).toBe("Copy to clipboard");
		// SVG icon present (no inline text content on the button).
		expect(button?.querySelector("svg")).toBeTruthy();

		const live = root?.querySelector("span.sr-live");
		expect(live).toBeTruthy();
		expect(live?.getAttribute("role")).toBe("status");
		expect(live?.getAttribute("aria-live")).toBe("polite");
		expect(live?.textContent).toBe("");
	});

	it("clicking the button writes JSON.stringify(value, null, 2) to the clipboard for an object", async () => {
		const value = { orderId: 42, items: [{ sku: "X" }] };
		const root = bag.window.wfeRenderJsonTree?.(value);
		const button = root?.querySelector(
			"button.json-tree-copy",
		) as HTMLButtonElement;

		button.dispatchEvent(new bag.window.Event("click", { bubbles: true }));

		await flushPromises();
		expect(bag.clipboardWrites).toHaveLength(1);
		expect(bag.clipboardWrites[0]).toBe(JSON.stringify(value, null, 2));
	});

	it("copies a primitive null root", async () => {
		const root = bag.window.wfeRenderJsonTree?.(null);
		const button = root?.querySelector(
			"button.json-tree-copy",
		) as HTMLButtonElement;
		button.dispatchEvent(new bag.window.Event("click", { bubbles: true }));
		await flushPromises();
		expect(bag.clipboardWrites).toEqual(["null"]);
	});

	it("copies an empty object root", async () => {
		const root = bag.window.wfeRenderJsonTree?.({});
		const button = root?.querySelector(
			"button.json-tree-copy",
		) as HTMLButtonElement;
		button.dispatchEvent(new bag.window.Event("click", { bubbles: true }));
		await flushPromises();
		expect(bag.clipboardWrites).toEqual(["{}"]);
	});

	it("copies an empty array root", async () => {
		const root = bag.window.wfeRenderJsonTree?.([]);
		const button = root?.querySelector(
			"button.json-tree-copy",
		) as HTMLButtonElement;
		button.dispatchEvent(new bag.window.Event("click", { bubbles: true }));
		await flushPromises();
		expect(bag.clipboardWrites).toEqual(["[]"]);
	});

	it("the copied payload reflects the source value, not the visible (collapsed) state", async () => {
		const root = bag.window.wfeRenderJsonTree?.({ a: 1, b: { c: 2 } });
		// Collapse the nested `b` container so its contents are no longer
		// visible in the rendered DOM. The copied payload must still include
		// the full source value.
		const containers = Array.from(
			root?.querySelectorAll(".json-tree-container") ?? [],
		);
		const nested = containers.find((c) => c !== containers[0]);
		const disclosure = nested?.querySelector(
			"button.json-tree-disclosure",
		) as HTMLButtonElement;
		disclosure.dispatchEvent(new bag.window.Event("click", { bubbles: true }));
		expect(nested?.getAttribute("data-collapsed")).toBe("true");

		const button = root?.querySelector(
			"button.json-tree-copy",
		) as HTMLButtonElement;
		button.dispatchEvent(new bag.window.Event("click", { bubbles: true }));
		await flushPromises();

		expect(bag.clipboardWrites[0]).toBe(
			JSON.stringify({ a: 1, b: { c: 2 } }, null, 2),
		);
	});

	it("on success, swaps the icon, adds the --copied class, announces 'Copied', then reverts", async () => {
		vi.useFakeTimers();
		const root = bag.window.wfeRenderJsonTree?.({ a: 1 });
		const button = root?.querySelector(
			"button.json-tree-copy",
		) as HTMLButtonElement;
		const live = root?.querySelector("span.sr-live") as HTMLSpanElement;

		// Idle: copy icon (rect + path), no --copied modifier, empty live region.
		expect(button.classList.contains("json-tree-copy--copied")).toBe(false);
		expect(button.querySelector("rect")).toBeTruthy();
		expect(live.textContent).toBe("");

		button.dispatchEvent(new bag.window.Event("click", { bubbles: true }));

		// Allow the resolved Promise.then() to run.
		await vi.advanceTimersByTimeAsync(0);

		expect(button.classList.contains("json-tree-copy--copied")).toBe(true);
		// Check icon path replaces the copy icon (no rect).
		expect(button.querySelector("rect")).toBeNull();
		expect(button.querySelector("path")).toBeTruthy();
		expect(live.textContent).toBe("Copied");

		// Advance past the revert delay.
		await vi.advanceTimersByTimeAsync(2000);

		expect(button.classList.contains("json-tree-copy--copied")).toBe(false);
		expect(button.querySelector("rect")).toBeTruthy();
		expect(live.textContent).toBe("");
	});

	it("does not introduce inline on*=, style=, or x-data attributes anywhere under the tree", () => {
		const root = bag.window.wfeRenderJsonTree?.({ a: 1, b: [2, 3] });
		const all = root?.querySelectorAll("*") ?? [];
		for (const el of all) {
			for (const attr of Array.from(el.attributes)) {
				expect(attr.name.toLowerCase()).not.toMatch(/^on/);
				expect(attr.name.toLowerCase()).not.toBe("style");
			}
		}
		expect(root?.querySelector("[x-data]")).toBeNull();
	});
});
