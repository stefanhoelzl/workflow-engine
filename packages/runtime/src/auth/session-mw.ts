import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { LOGIN_PATH, SESSION_COOKIE, SEVEN_DAYS_SECONDS } from "./constants.js";
import { writeOpts } from "./cookie-opts.js";
import type { ProviderRegistry } from "./providers/index.js";
import { redirectToLoginWithFlash } from "./redirect-to-login.js";
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

function loginRedirectUrl(c: Context): string {
	const url = new URL(c.req.url);
	const returnTo = url.pathname + url.search;
	return `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

async function writeSession(
	c: Context,
	payload: SessionPayload,
	secure: boolean,
) {
	const sealed = await sealSession(payload);
	setCookie(
		c,
		SESSION_COOKIE,
		sealed,
		writeOpts("/", secure, SEVEN_DAYS_SECONDS),
	);
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
			return redirectToLoginWithFlash(c, { kind: "logged-out" }, secureCookies);
		}

		const now = nowFn();
		if (isExpired(payload, now)) {
			return redirectToLoginWithFlash(c, { kind: "logged-out" }, secureCookies);
		}

		const provider = registry.byId(payload.provider);
		if (!provider) {
			return redirectToLoginWithFlash(c, { kind: "logged-out" }, secureCookies);
		}

		if (!isStale(payload, now)) {
			c.set("user", userFromPayload(payload));
			await next();
			return;
		}

		const result = await provider.refreshSession(payload);
		if (!result.ok) {
			const flash =
				result.reason === "access-denied"
					? { kind: "denied" as const, login: payload.login }
					: { kind: "logged-out" as const };
			return redirectToLoginWithFlash(c, flash, secureCookies);
		}
		const nextPayload: SessionPayload = {
			provider: payload.provider,
			login: result.user.login,
			mail: result.user.mail,
			orgs: [...result.user.orgs],
			accessToken: payload.accessToken,
			resolvedAt: now,
			exp: payload.exp,
		};
		await writeSession(c, nextPayload, secureCookies);
		c.set("user", result.user);
		await next();
	};
}

export type { SessionMiddlewareOptions };
export { sessionMiddleware };
