import { describe, expect, test } from "@workflow-engine/tests";

// Test #10 — dashboard UI under chromium. Fires a webhook to produce a
// real invocation, then drives the browser through `/dashboard/dev/e2e`,
// finds the invocation row for the registered workflow, expands it, and
// asserts the htmx-loaded flamegraph fragment contains the `kind-trigger`
// SVG class. Exercises the dashboard's full server-render → htmx swap →
// flamegraph render pipeline that the in-process integration layer can't
// see (no real browser, no htmx runtime, no SVG layout).

describe("dashboard UI", () => {
	test("invocation row renders for the fired workflow and expands to flamegraph", (s) =>
		s
			.workflow(
				"uitest",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	request: { body: z.object({}) },
	handler: async () => ({status: 200, body: "pong"}),
});
`,
			)
			.webhook("ping", { body: {} })
			.waitForEvent({ trigger: "ping", kind: "trigger.response" })
			.browser(async ({ page, state, login }) => {
				await login("dev");
				const wf = state.workflows.byIndex(0).name;
				await page.goto("/dashboard/dev/e2e");
				const entry = page
					.locator(".entry")
					.filter({ has: page.locator(`.entry-workflow:text-is("${wf}")`) })
					.first();
				await entry.waitFor({ state: "visible" });
				expect(
					(await entry.locator(".entry-workflow").innerText()).trim(),
				).toBe(wf);
				expect((await entry.locator(".entry-trigger").innerText()).trim()).toBe(
					"ping",
				);
				await entry.locator("summary").click();
				await entry
					.locator(".kind-trigger")
					.first()
					.waitFor({ state: "visible", timeout: 5000 });
			}));
});
