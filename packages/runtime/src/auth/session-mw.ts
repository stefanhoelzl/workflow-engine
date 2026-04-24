import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import {
	FLASH_COOKIE,
	LOGIN_PATH,
	SESSION_COOKIE,
	SEVEN_DAYS_SECONDS,
	SIXTY_SECONDS,
} from "./constants.js";
import { sealFlash } from "./flash-cookie.js";
import type { ProviderRegistry } from "./providers/index.js";
import {
	isExpired,
	isStale,
	type SessionPayload,
	sealSession,
	unsealSession,
	userFromPayload,
} from "./session-cookie.js";

interface SessionMiddlewareOptions {
	readonly registry: ProviderRegistry;
	readonly secureCookies: boolean;
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

function sessionMiddleware(
	options: SessionMiddlewareOptions,
): MiddlewareHandler {
	const { registry, secureCookies } = options;
	const nowFn = options.nowFn ?? (() => Date.now());

	return async (c, next) => {
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

		const provider = registry.byId(payload.provider);
		if (!provider) {
			clearSession(c, secureCookies);
			return c.redirect(loginRedirectUrl(c));
		}

		if (!isStale(payload, now)) {
			c.set("user", userFromPayload(payload));
			await next();
			return;
		}

		const refreshed = await provider.refreshSession(payload);
		if (!refreshed) {
			await setFlash(c, payload.login, secureCookies);
			clearSession(c, secureCookies);
			return c.redirect(LOGIN_PATH);
		}
		const nextPayload: SessionPayload = {
			provider: payload.provider,
			login: refreshed.login,
			mail: refreshed.mail,
			orgs: [...refreshed.orgs],
			accessToken: payload.accessToken,
			resolvedAt: now,
			exp: payload.exp,
		};
		await writeSession(c, nextPayload, secureCookies);
		c.set("user", refreshed);
		await next();
	};
}

export type { SessionMiddlewareOptions };
export { sessionMiddleware };
