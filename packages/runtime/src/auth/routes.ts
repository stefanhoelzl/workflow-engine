import { webcrypto } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { Middleware } from "../triggers/http.js";
import { renderLoginPage } from "../ui/auth/login-page.js";
import { type Auth, allow } from "./allowlist.js";
import {
	FIVE_MINUTES_SECONDS,
	FLASH_COOKIE,
	HTTP_BAD_GATEWAY,
	HTTP_BAD_REQUEST,
	HTTP_METHOD_NOT_ALLOWED,
	LOGIN_PATH,
	SESSION_COOKIE,
	SEVEN_DAYS_MS,
	SEVEN_DAYS_SECONDS,
	SIXTY_SECONDS,
	STATE_COOKIE,
} from "./constants.js";
import { sealFlash, unsealFlash } from "./flash-cookie.js";
import { buildAuthorizeUrl, exchangeCode, resolveUser } from "./github-api.js";
import { type SessionPayload, sealSession } from "./session-cookie.js";
import { sanitizeReturnTo, sealState, unsealState } from "./state-cookie.js";

const STATE_BYTES = 32;
const BASE64_PLUS_RE = /\+/g;
const BASE64_SLASH_RE = /\//g;
const BASE64_PAD_RE = /=+$/;

interface LoginPageOptions {
	readonly secureCookies: boolean;
}

interface AuthRoutesOptions extends LoginPageOptions {
	readonly auth: Auth;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly baseUrl: string;
	readonly fetchFn?: typeof globalThis.fetch;
	readonly nowFn?: () => number;
}

function clearOpts(path: string, secure: boolean): CookieOptions {
	return { path, secure, httpOnly: true, sameSite: "Lax" };
}

function writeOpts(
	path: string,
	secure: boolean,
	maxAge: number,
): CookieOptions {
	return { ...clearOpts(path, secure), maxAge };
}

function generateState(): string {
	const bytes = new Uint8Array(STATE_BYTES);
	webcrypto.getRandomValues(bytes);
	let bin = "";
	for (const b of bytes) {
		bin += String.fromCharCode(b);
	}
	return btoa(bin)
		.replace(BASE64_PLUS_RE, "-")
		.replace(BASE64_SLASH_RE, "_")
		.replace(BASE64_PAD_RE, "");
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
		return c.html(renderLoginPage({ flash, returnTo }));
	});

	return {
		match: "/login",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one Hono app wires signin + callback + logout; splitting fragments the OAuth flow
function authMiddleware(options: AuthRoutesOptions): Middleware {
	const app = new Hono();
	const secure = options.secureCookies;
	const nowFn = options.nowFn ?? (() => Date.now());

	app.get("/auth/github/signin", async (c) => {
		const returnTo = sanitizeReturnTo(c.req.query("returnTo"));
		const state = generateState();
		const sealed = await sealState({ state, returnTo });
		setCookie(
			c,
			STATE_COOKIE,
			sealed,
			writeOpts("/auth", secure, FIVE_MINUTES_SECONDS),
		);
		const authorizeUrl = buildAuthorizeUrl({
			clientId: options.clientId,
			redirectUri: `${options.baseUrl}/auth/github/callback`,
			state,
		});
		return c.redirect(authorizeUrl);
	});

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one branch per spec-enumerated failure mode
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: callback state machine is inherently branchy
	app.get("/auth/github/callback", async (c) => {
		const code = c.req.query("code");
		const stateParam = c.req.query("state");
		if (code === undefined || stateParam === undefined) {
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}
		const stateRaw = getCookie(c, STATE_COOKIE);
		if (stateRaw === undefined) {
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}
		let state: { state: string; returnTo: string };
		try {
			state = await unsealState(stateRaw);
		} catch {
			deleteCookie(c, STATE_COOKIE, clearOpts("/auth", secure));
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}
		deleteCookie(c, STATE_COOKIE, clearOpts("/auth", secure));
		if (state.state !== stateParam) {
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}

		const tokenRes = await exchangeCode({
			clientId: options.clientId,
			clientSecret: options.clientSecret,
			code,
			redirectUri: `${options.baseUrl}/auth/github/callback`,
			...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
		});
		if (!tokenRes.ok) {
			return c.text("Bad Gateway", HTTP_BAD_GATEWAY);
		}
		const userRes = await resolveUser({
			accessToken: tokenRes.data.accessToken,
			...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
		});
		if (!userRes.ok) {
			return c.text("Bad Gateway", HTTP_BAD_GATEWAY);
		}
		const user = userRes.data;

		if (options.auth.mode !== "restricted" || !allow(user, options.auth)) {
			const flash = await sealFlash({ kind: "denied", login: user.name });
			setCookie(c, FLASH_COOKIE, flash, writeOpts("/", secure, SIXTY_SECONDS));
			deleteCookie(c, SESSION_COOKIE, clearOpts("/", secure));
			return c.redirect(LOGIN_PATH);
		}

		const now = nowFn();
		const payload: SessionPayload = {
			name: user.name,
			mail: user.mail,
			orgs: [...user.orgs],
			accessToken: tokenRes.data.accessToken,
			resolvedAt: now,
			exp: now + SEVEN_DAYS_MS,
		};
		const sealed = await sealSession(payload);
		setCookie(
			c,
			SESSION_COOKIE,
			sealed,
			writeOpts("/", secure, SEVEN_DAYS_SECONDS),
		);
		return c.redirect(state.returnTo);
	});

	// Redirects to /login with a logged-out flash rather than to "/" directly.
	// "/" would chase sessionMw → /login → GitHub → silent re-auth via the
	// still-live OAuth grant, making sign-out appear to be a no-op.
	app.post("/auth/logout", async (c) => {
		deleteCookie(c, SESSION_COOKIE, clearOpts("/", secure));
		const flash = await sealFlash({ kind: "logged-out" });
		setCookie(c, FLASH_COOKIE, flash, writeOpts("/", secure, SIXTY_SECONDS));
		return c.redirect(LOGIN_PATH);
	});
	app.on(
		["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"],
		"/auth/logout",
		(c) => c.text("Method Not Allowed", HTTP_METHOD_NOT_ALLOWED),
	);

	return {
		match: "/auth/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { AuthRoutesOptions, LoginPageOptions };
export { authMiddleware, loginPageMiddleware };
