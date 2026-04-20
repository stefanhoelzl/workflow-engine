import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { type Auth, allow } from "./allowlist.js";
import {
	FLASH_COOKIE,
	HTTP_UNAUTHORIZED,
	LOGIN_PATH,
	SESSION_COOKIE,
	SEVEN_DAYS_SECONDS,
	SIXTY_SECONDS,
} from "./constants.js";
import { sealFlash } from "./flash-cookie.js";
import { resolveUser } from "./github-api.js";
import {
	isExpired,
	isStale,
	type SessionPayload,
	sealSession,
	unsealSession,
	userFromPayload,
} from "./session-cookie.js";

interface SessionMiddlewareOptions {
	readonly auth: Auth;
	readonly secureCookies: boolean;
	readonly fetchFn?: typeof globalThis.fetch;
	readonly nowFn?: () => number;
}

function clearOpts(secure: boolean): CookieOptions {
	return { path: "/", secure, httpOnly: true, sameSite: "Lax" };
}

function writeOpts(secure: boolean, maxAge: number): CookieOptions {
	return { ...clearOpts(secure), maxAge };
}

function loginRedirectUrl(c: Context): string {
	const url = new URL(c.req.url);
	const returnTo = url.pathname + url.search;
	return `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

function clearSession(c: Context, secure: boolean) {
	deleteCookie(c, SESSION_COOKIE, clearOpts(secure));
}

async function setFlash(c: Context, login: string, secure: boolean) {
	const sealed = await sealFlash({ kind: "denied", login });
	setCookie(c, FLASH_COOKIE, sealed, writeOpts(secure, SIXTY_SECONDS));
}

async function writeSession(
	c: Context,
	payload: SessionPayload,
	secure: boolean,
) {
	const sealed = await sealSession(payload);
	setCookie(c, SESSION_COOKIE, sealed, writeOpts(secure, SEVEN_DAYS_SECONDS));
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: returned handler is the session state machine; splitting the factory doesn't help
function sessionMiddleware(
	options: SessionMiddlewareOptions,
): MiddlewareHandler {
	const { auth, secureCookies } = options;
	const nowFn = options.nowFn ?? (() => Date.now());

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: session state machine matches the spec's explicit branches (disabled/open/fresh/stale/refresh failures)
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ditto; splitting fragments the flow
	return async (c, next) => {
		if (auth.mode === "disabled") {
			// 401 (not a /login redirect): when auth is disabled the instance
			// is locked and /login has no way to sign anyone in.
			return c.json({ error: "Unauthorized" }, HTTP_UNAUTHORIZED);
		}
		if (auth.mode === "open") {
			c.set("authOpen", true);
			await next();
			return;
		}

		const raw = getCookie(c, SESSION_COOKIE);
		if (raw === undefined) {
			return c.redirect(loginRedirectUrl(c));
		}

		let payload: SessionPayload;
		try {
			payload = await unsealSession(raw);
		} catch {
			clearSession(c, secureCookies);
			return c.redirect(loginRedirectUrl(c));
		}

		const now = nowFn();
		if (isExpired(payload, now)) {
			clearSession(c, secureCookies);
			return c.redirect(loginRedirectUrl(c));
		}

		if (!isStale(payload, now)) {
			const user = userFromPayload(payload);
			if (!allow(user, auth)) {
				await setFlash(c, user.name, secureCookies);
				clearSession(c, secureCookies);
				return c.redirect(LOGIN_PATH);
			}
			c.set("user", user);
			await next();
			return;
		}

		const refreshed = await resolveUser({
			accessToken: payload.accessToken,
			...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
		});
		if (!refreshed.ok) {
			clearSession(c, secureCookies);
			return c.redirect(loginRedirectUrl(c));
		}
		const user = refreshed.data;
		if (!allow(user, auth)) {
			await setFlash(c, user.name, secureCookies);
			clearSession(c, secureCookies);
			return c.redirect(LOGIN_PATH);
		}
		const nextPayload: SessionPayload = {
			name: user.name,
			mail: user.mail,
			orgs: [...user.orgs],
			accessToken: payload.accessToken,
			resolvedAt: now,
			exp: payload.exp,
		};
		await writeSession(c, nextPayload, secureCookies);
		c.set("user", user);
		await next();
	};
}

export type { SessionMiddlewareOptions };
export { sessionMiddleware };
