import { describe, expect, test } from "@workflow-engine/tests";

// Test #11 — trigger UI under chromium. Drives the single-trigger page
// for a manualTrigger card, fills the Jedison-rendered input, clicks
// Submit, and asserts the in-page result dialog (rendered by
// /static/result-dialog.js) shows the dispatched output. Exercises the
// browser-side JSON-Schema → form → fetch → result-dialog pipeline that
// the in-process layer cannot reach (no real DOM, no dialog, no
// clipboard wiring).

describe("trigger UI", () => {
	test("manualTrigger card submits user input and renders the response", (s) =>
		s
			.workflow(
				"greeter",
				`
import {manualTrigger, z} from "@workflow-engine/sdk";

export const greet = manualTrigger({
	input: z.object({name: z.string()}),
	output: z.object({hello: z.string()}),
	handler: async ({name}) => ({hello: \`hi \${name}\`}),
});
`,
			)
			.browser(async ({ page, state, login }) => {
				await login("dev");
				const wf = state.workflows.byIndex(0).name;
				await page.goto(`/trigger/dev/e2e/${wf}/greet`);
				const nameInput = page.locator('[data-path="#/name"] input').first();
				await nameInput.waitFor({ state: "visible" });
				await nameInput.fill("world");
				await page.locator(".submit-btn[data-trigger-url]").first().click();
				const body = page.locator(".trigger-result-body").first();
				await body.waitFor({ state: "visible" });
				const text = await body.innerText();
				expect(text).toContain('"hello": "hi world"');
			}));
});
