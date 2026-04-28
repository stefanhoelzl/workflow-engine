// DOM-level helper for HTML assertions in middleware tests. Wraps
// `linkedom`'s parser so tests can do `dom(html).querySelector(...)` and
// assert on element presence / attribute values / textContent without
// hand-coded regex.
//
// Usage:
//   import { dom } from "../test-utils.js";
//   const d = dom(html);
//   expect(d.querySelector("#inv-evt_pending")).toBeTruthy();
//   expect(d.querySelector(".badge.failed")?.textContent).toBe("failed");
//
// Most existing string-level assertions in dashboard/middleware.test.ts
// and trigger/middleware.test.ts continue to pass against the JSX output,
// so the bulk DOM migration is deferred to a follow-up PR. New tests
// should prefer `dom(html)` over `expect(html).toContain(...)`.

import { parseHTML } from "linkedom";

function dom(html: string): Document {
	return parseHTML(html).document;
}

export { dom };
