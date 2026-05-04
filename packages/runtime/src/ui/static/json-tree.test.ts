import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it } from "vitest";

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
}

function bootScript(): Bag {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	// Provide a fetch shim — the script doesn't use it at module load, but the
	// queueCardFactory references it, and Alpine isn't booted here so Alpine
	// component registration is a no-op (the `if (!register())` branch
	// re-arms registration on `alpine:init`, which we don't fire).
	(window as unknown as Record<string, unknown>).fetch = async () =>
		new Response("");
	new Function("window", "document", SCRIPT_SRC)(window, window.document);
	return { window: window as Bag["window"], document: window.document };
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
