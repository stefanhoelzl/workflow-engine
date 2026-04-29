import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { ChevronDownIcon } from "../../ui/icons.js";
import {
	HTTP_BAD_REQUEST,
	SESSION_COOKIE,
	SEVEN_DAYS_MS,
	SEVEN_DAYS_SECONDS,
} from "../constants.js";
import { writeOpts } from "../cookie-opts.js";
import { type SessionPayload, sealSession } from "../session-cookie.js";
import { sanitizeReturnTo } from "../state-cookie.js";
import type { UserContext } from "../user-context.js";
import type {
	AuthProvider,
	AuthProviderFactory,
	LoginSection,
	ProviderRouteDeps,
} from "./types.js";

const ID = "local";
const ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9]*$/;
const MAIL_SUFFIX = "@dev.local";

interface LocalEntry {
	readonly name: string;
	readonly orgs: readonly string[];
}

function parseLocalRest(rest: string): LocalEntry {
	const parts = rest.split(":");
	const expectedMin = 1;
	const expectedMax = 2;
	if (parts.length < expectedMin || parts.length > expectedMax) {
		throw new Error(
			`AUTH_ALLOW: malformed local entry "local:${rest}" (expected local:<name> or local:<name>:<orgs>)`,
		);
	}
	const [name, orgsRaw] = parts as [string, string | undefined];
	if (!ID_REGEX.test(name)) {
		throw new Error(
			`AUTH_ALLOW: invalid local user name "${name}" in entry "local:${rest}"`,
		);
	}
	if (orgsRaw === undefined) {
		return { name, orgs: [] };
	}
	if (orgsRaw.includes(",")) {
		throw new Error(
			`AUTH_ALLOW: local entry "local:${rest}": orgs use '|' separator (e.g. acme|foo)`,
		);
	}
	const orgs = orgsRaw.split("|");
	for (const org of orgs) {
		if (!ID_REGEX.test(org)) {
			throw new Error(
				`AUTH_ALLOW: invalid local org "${org}" in entry "local:${rest}"`,
			);
		}
	}
	return { name, orgs };
}

function userFromEntry(entry: LocalEntry): UserContext {
	return {
		login: entry.name,
		mail: `${entry.name}${MAIL_SUFFIX}`,
		orgs: [entry.name, ...entry.orgs],
	};
}

function LocalUserItem({ name }: { name: string }) {
	return (
		<button type="submit" name="user" value={name} class="auth-local__item">
			<span class="auth-local__avatar" aria-hidden="true">
				{name.slice(0, 1).toUpperCase()}
			</span>
			<span class="auth-local__name">{name}</span>
		</button>
	);
}

function buildSignin(
	deps: ProviderRouteDeps,
	byName: ReadonlyMap<string, LocalEntry>,
) {
	return async (c: Context) => {
		const body = await c.req.parseBody();
		const userField = body.user;
		const returnToField = body.returnTo;
		const userName = typeof userField === "string" ? userField : "";
		const returnToRaw =
			typeof returnToField === "string" ? returnToField : undefined;
		const entry = byName.get(userName);
		if (!entry) {
			return c.text("Bad Request", HTTP_BAD_REQUEST);
		}
		const user = userFromEntry(entry);
		const now = deps.nowFn();
		const payload: SessionPayload = {
			provider: "local",
			login: user.login,
			mail: user.mail,
			orgs: [...user.orgs],
			accessToken: "",
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
		const returnTo = sanitizeReturnTo(returnToRaw);
		return c.redirect(returnTo);
	};
}

function createLocalProvider(
	rawEntries: readonly string[],
	deps: ProviderRouteDeps,
): AuthProvider {
	const entries = rawEntries.map(parseLocalRest);
	const byName = new Map<string, LocalEntry>();
	for (const e of entries) {
		byName.set(e.name, e);
	}

	return {
		id: ID,

		renderLoginSection(returnTo: string): LoginSection {
			return (
				<form
					method="post"
					action="/auth/local/signin"
					class="auth-card__local"
				>
					<input type="hidden" name="returnTo" value={returnTo} />
					<details class="auth-local">
						<summary class="auth-btn auth-btn--local auth-local__summary">
							<span>Sign in locally</span>
							<ChevronDownIcon class="auth-btn__chevron" />
						</summary>
						<div class="auth-local__list">
							{entries.map((e) => (
								<LocalUserItem name={e.name} />
							))}
						</div>
					</details>
				</form>
			);
		},

		mountAuthRoutes(app: Hono): void {
			app.post("/signin", buildSignin(deps, byName));
		},

		resolveApiIdentity(req: Request): Promise<UserContext | undefined> {
			const auth = req.headers.get("authorization") ?? "";
			if (!auth.startsWith("User ")) {
				return Promise.resolve(undefined);
			}
			const value = auth.slice("User ".length).trim();
			if (value === "") {
				return Promise.resolve(undefined);
			}
			const entry = byName.get(value);
			if (!entry) {
				return Promise.resolve(undefined);
			}
			return Promise.resolve(userFromEntry(entry));
		},

		refreshSession(payload: SessionPayload): Promise<UserContext | undefined> {
			return Promise.resolve({
				login: payload.login,
				mail: payload.mail,
				orgs: payload.orgs,
			});
		},
	};
}

const localProviderFactory: AuthProviderFactory = {
	id: ID,
	create: createLocalProvider,
};

export { localProviderFactory };
