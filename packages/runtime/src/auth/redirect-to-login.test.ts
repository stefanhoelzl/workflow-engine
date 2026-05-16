import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FLASH_COOKIE, SESSION_COOKIE } from "./constants.js";
import { unsealFlash } from "./flash-cookie.js";
import { redirectToLoginWithFlash } from "./redirect-to-login.js";

function mkApp() {
	const app = new Hono();
	app.get("/denied", (c) =>
		redirectToLoginWithFlash(c, { kind: "denied", login: "alice" }, false),
	);
	app.get("/logged-out", (c) =>
		redirectToLoginWithFlash(c, { kind: "logged-out" }, false),
	);
	return app;
}

describe("redirectToLoginWithFlash", () => {
	it("emits 302 to /login with a denied flash and clears the session", async () => {
		const res = await mkApp().request("/denied");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		const setCookies = res.headers.getSetCookie();
		const session = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=;`));
		expect(session).toBeDefined();
		const flash = setCookies.find((c) => c.startsWith(`${FLASH_COOKIE}=`));
		const flashValue = flash?.split(";")[0]?.split("=")[1] ?? "";
		await expect(unsealFlash(flashValue)).resolves.toEqual({
			kind: "denied",
			login: "alice",
		});
	});

	it("emits 302 to /login with a logged-out flash", async () => {
		const res = await mkApp().request("/logged-out");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		const setCookies = res.headers.getSetCookie();
		const flash = setCookies.find((c) => c.startsWith(`${FLASH_COOKIE}=`));
		const flashValue = flash?.split(";")[0]?.split("=")[1] ?? "";
		await expect(unsealFlash(flashValue)).resolves.toEqual({
			kind: "logged-out",
		});
	});
});
