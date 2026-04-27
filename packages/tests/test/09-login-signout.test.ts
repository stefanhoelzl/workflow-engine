import { describe, expect, test } from "@workflow-engine/tests";

// Test #9 — local login + signout flow under chromium. Drives the real
// `/login` form, asserts the sealed `session` cookie persists across a page
// reload, clicks the topbar Sign-out button (POST /auth/logout), and
// verifies that an unauthenticated visit to `/dashboard` redirects to
// `/login`. Exercises the spec's session-middleware redirect contract end
// to end — a flow that the in-process integration layer cannot cover
// because it has no real browser cookie jar or form submission semantics.

describe("local login + signout", () => {
	test("login persists, signout clears, /dashboard redirects to /login", (s) =>
		s.browser(async ({ page, login }) => {
			await login("dev");
			expect(new URL(page.url()).pathname).toBe("/dashboard");

			await page.reload();
			expect(new URL(page.url()).pathname).toBe("/dashboard");

			await Promise.all([
				page.waitForURL("**/login"),
				page.locator("form.topbar-signout-form button[type=submit]").click(),
			]);
			expect(new URL(page.url()).pathname).toBe("/login");

			await page.goto("/dashboard");
			expect(new URL(page.url()).pathname).toBe("/login");
		}));
});
