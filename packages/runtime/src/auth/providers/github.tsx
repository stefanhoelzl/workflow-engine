import { webcrypto } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { GithubIcon } from "../../ui/icons.js";
import {
	FIVE_MINUTES_SECONDS,
	FLASH_COOKIE,
	HTTP_BAD_GATEWAY,
	HTTP_BAD_REQUEST,
	LOGIN_PATH,
	SESSION_COOKIE,
	SEVEN_DAYS_MS,
	SEVEN_DAYS_SECONDS,
	SIXTY_SECONDS,
	STATE_COOKIE,
} from "../constants.js";
import { sealFlash } from "../flash-cookie.js";
import { buildAuthorizeUrl, exchangeCode, resolveUser } from "../github-api.js";
import { type SessionPayload, sealSession } from "../session-cookie.js";
import { sanitizeReturnTo, sealState, unsealState } from "../state-cookie.js";
import type { UserContext } from "../user-context.js";
import type {
	AuthProvider,
	AuthProviderFactory,
	LoginSection,
	ProviderRouteDeps,
} from "./types.js";

const ID = "github";
const ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9]*$/;
const STATE_BYTES = 32;
const BASE64_PLUS_RE = /\+/g;
const BASE64_SLASH_RE = /\//g;
const BASE64_PAD_RE = /=+$/;

interface GithubEntry {
	readonly kind: "user" | "org";
	readonly id: string;
}

function parseGithubRest(rest: string): GithubEntry {
	const parts = rest.split(":");
	const expected = 2;
	if (parts.length !== expected) {
		throw new Error(
			`AUTH_ALLOW: malformed github entry "github:${rest}" (expected github:user|org:<id>)`,
		);
	}
	const [kind, id] = parts as [string, string];
	if (kind !== "user" && kind !== "org") {
		throw new Error(
			`AUTH_ALLOW: unknown github kind "${kind}" in entry "github:${rest}"`,
		);
	}
	if (!ID_REGEX.test(id)) {
		throw new Error(
			`AUTH_ALLOW: invalid identifier "${id}" in entry "github:${rest}"`,
		);
	}
	return { kind, id };
}

// See session-mw.ts `clearOpts` for the iframe-friendly local-dev variant.
function clearOpts(path: string, secure: boolean): CookieOptions {
	if (secure) {
		return { path, secure: true, httpOnly: true, sameSite: "Lax" };
	}
	return {
		path,
		secure: true,
		httpOnly: true,
		sameSite: "None",
		partitioned: true,
	};
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

function isAllowed(
	user: UserContext,
	users: ReadonlySet<string>,
	orgs: ReadonlySet<string>,
): boolean {
	if (users.has(user.login)) {
		return true;
	}
	for (const o of user.orgs) {
		if (orgs.has(o)) {
			return true;
		}
	}
	return false;
}

interface GithubDeps {
	readonly secureCookies: boolean;
	readonly nowFn: () => number;
	readonly fetchFn: typeof globalThis.fetch | undefined;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly baseUrl: string;
}

function ensureGithubDeps(deps: ProviderRouteDeps): GithubDeps {
	if (
		deps.clientId === undefined ||
		deps.clientSecret === undefined ||
		deps.baseUrl === undefined
	) {
		throw new Error(
			"github provider requires GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, and BASE_URL",
		);
	}
	return {
		secureCookies: deps.secureCookies,
		nowFn: deps.nowFn,
		fetchFn: deps.fetchFn,
		clientId: deps.clientId,
		clientSecret: deps.clientSecret,
		baseUrl: deps.baseUrl,
	};
}

function buildSignin(deps: GithubDeps) {
	return async (c: Context) => {
		const returnTo = sanitizeReturnTo(c.req.query("returnTo"));
		const state = generateState();
		const sealed = await sealState({ state, returnTo });
		setCookie(
			c,
			STATE_COOKIE,
			sealed,
			writeOpts("/auth", deps.secureCookies, FIVE_MINUTES_SECONDS),
		);
		const authorizeUrl = buildAuthorizeUrl({
			clientId: deps.clientId,
			redirectUri: `${deps.baseUrl}/auth/github/callback`,
			state,
		});
		return c.redirect(authorizeUrl);
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: callback state machine matches the spec's enumerated failure modes
function buildCallback(
	deps: GithubDeps,
	users: ReadonlySet<string>,
	orgs: ReadonlySet<string>,
) {
	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: callback state machine matches the spec's enumerated failure modes
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: branchy by spec
	return async (c: Context) => {
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
			deleteCookie(c, STATE_COOKIE, clearOpts("/auth", deps.secureCookies));
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}
		deleteCookie(c, STATE_COOKIE, clearOpts("/auth", deps.secureCookies));
		if (state.state !== stateParam) {
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}

		const tokenRes = await exchangeCode({
			clientId: deps.clientId,
			clientSecret: deps.clientSecret,
			code,
			redirectUri: `${deps.baseUrl}/auth/github/callback`,
			...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
		});
		if (!tokenRes.ok) {
			return c.text("Bad Gateway", HTTP_BAD_GATEWAY);
		}
		const userRes = await resolveUser({
			accessToken: tokenRes.data.accessToken,
			...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
		});
		if (!userRes.ok) {
			return c.text("Bad Gateway", HTTP_BAD_GATEWAY);
		}
		const user = userRes.data;

		if (!isAllowed(user, users, orgs)) {
			const flash = await sealFlash({
				kind: "denied",
				login: user.login,
			});
			setCookie(
				c,
				FLASH_COOKIE,
				flash,
				writeOpts("/", deps.secureCookies, SIXTY_SECONDS),
			);
			deleteCookie(c, SESSION_COOKIE, clearOpts("/", deps.secureCookies));
			return c.redirect(LOGIN_PATH);
		}

		const now = deps.nowFn();
		const payload: SessionPayload = {
			provider: "github",
			login: user.login,
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
			writeOpts("/", deps.secureCookies, SEVEN_DAYS_SECONDS),
		);
		return c.redirect(state.returnTo);
	};
}

function createGithubProvider(
	rawEntries: readonly string[],
	rawDeps: ProviderRouteDeps,
): AuthProvider {
	const entries = rawEntries.map(parseGithubRest);
	const users = new Set(
		entries.filter((e) => e.kind === "user").map((e) => e.id),
	);
	const orgs = new Set(
		entries.filter((e) => e.kind === "org").map((e) => e.id),
	);
	const deps = ensureGithubDeps(rawDeps);

	return {
		id: ID,

		renderLoginSection(returnTo: string): LoginSection {
			const href = `/auth/github/signin?returnTo=${encodeURIComponent(returnTo)}`;
			return (
				<a href={href} class="auth-btn auth-btn--github">
					<GithubIcon class="auth-btn__icon" />
					<span>Sign in with GitHub</span>
				</a>
			);
		},

		mountAuthRoutes(app: Hono): void {
			app.get("/signin", buildSignin(deps));
			app.get("/callback", buildCallback(deps, users, orgs));
		},

		async resolveApiIdentity(req: Request): Promise<UserContext | undefined> {
			const auth = req.headers.get("authorization") ?? "";
			if (!auth.startsWith("Bearer ")) {
				return;
			}
			const token = auth.slice("Bearer ".length).trim();
			if (token === "") {
				return;
			}
			const userRes = await resolveUser({
				accessToken: token,
				...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
			});
			if (!userRes.ok) {
				return;
			}
			if (!isAllowed(userRes.data, users, orgs)) {
				return;
			}
			return userRes.data;
		},

		async refreshSession(
			payload: SessionPayload,
		): Promise<UserContext | undefined> {
			const userRes = await resolveUser({
				accessToken: payload.accessToken,
				...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
			});
			if (!userRes.ok) {
				return;
			}
			if (!isAllowed(userRes.data, users, orgs)) {
				return;
			}
			return userRes.data;
		},
	};
}

const githubProviderFactory: AuthProviderFactory = {
	id: ID,
	create: createGithubProvider,
};

export { githubProviderFactory };
