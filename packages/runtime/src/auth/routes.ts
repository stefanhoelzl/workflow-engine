import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Middleware } from "../triggers/http.js";
import { renderLoginPage } from "../ui/auth/login-page.js";
import {
	FLASH_COOKIE,
	HTTP_METHOD_NOT_ALLOWED,
	LOGIN_PATH,
	SESSION_COOKIE,
	SIXTY_SECONDS,
} from "./constants.js";
import { clearOpts, writeOpts } from "./cookie-opts.js";
import { sealFlash, unsealFlash } from "./flash-cookie.js";
import type { ProviderRegistry } from "./providers/index.js";
import { sanitizeReturnTo } from "./state-cookie.js";

interface LoginPageOptions {
	readonly secureCookies: boolean;
	readonly registry: ProviderRegistry;
}

interface AuthRoutesOptions {
	readonly secureCookies: boolean;
	readonly registry: ProviderRegistry;
}

function loginPageMiddleware(options: LoginPageOptions): Middleware {
	const app = new Hono();
	const secure = options.secureCookies;

	app.get("/login", async (c) => {
		const flashRaw = getCookie(c, FLASH_COOKIE);
		let flash: Awaited<ReturnType<typeof unsealFlash>> | undefined;
		if (flashRaw !== undefined) {
			try {
				flash = await unsealFlash(flashRaw);
			} catch {
				flash = undefined;
			}
			deleteCookie(c, FLASH_COOKIE, clearOpts("/", secure));
		}
		const returnTo = sanitizeReturnTo(c.req.query("returnTo"));
		const sections = options.registry.providers.map((p) =>
			p.renderLoginSection(returnTo),
		);
		return c.html(renderLoginPage({ flash, returnTo, sections }));
	});

	return {
		match: "/login",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

function authMiddleware(options: AuthRoutesOptions): Middleware {
	const app = new Hono().basePath("/auth");
	const secure = options.secureCookies;

	for (const provider of options.registry.providers) {
		const sub = new Hono();
		provider.mountAuthRoutes(sub);
		app.route(`/${provider.id}`, sub);
	}

	// Logout is provider-agnostic: clear session, set logged-out flash, redirect
	// to /login. See SECURITY.md §4 / spec for why we redirect to /login (not /).
	app.post("/logout", async (c) => {
		deleteCookie(c, SESSION_COOKIE, clearOpts("/", secure));
		const flash = await sealFlash({ kind: "logged-out" });
		setCookie(c, FLASH_COOKIE, flash, writeOpts("/", secure, SIXTY_SECONDS));
		return c.redirect(LOGIN_PATH);
	});
	app.on(["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"], "/logout", (c) =>
		c.text("Method Not Allowed", HTTP_METHOD_NOT_ALLOWED),
	);

	return {
		match: "/auth/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { AuthRoutesOptions, LoginPageOptions };
export { authMiddleware, loginPageMiddleware };
