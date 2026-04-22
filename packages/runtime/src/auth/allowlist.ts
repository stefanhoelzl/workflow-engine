import type { UserContext } from "./user-context.js";

// AUTH_ALLOW grammar (see specs/auth):
//   AUTH_ALLOW = Entry ( "," Entry )*
//   Entry      = Provider ":" Kind ":" Id
//   Provider   = "github"
//   Kind       = "user" | "org"
//   Id         = [A-Za-z0-9][-A-Za-z0-9]*
// Whitespace around entries is trimmed. Empty entries (",,") are skipped.

const DISABLE_AUTH_SENTINEL = "__DISABLE_AUTH__";
const ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9]*$/;

interface ParsedAllowlist {
	readonly users: ReadonlySet<string>;
	readonly orgs: ReadonlySet<string>;
}

type Auth =
	| { readonly mode: "disabled" }
	| { readonly mode: "open" }
	| {
			readonly mode: "restricted";
			readonly users: ReadonlySet<string>;
			readonly orgs: ReadonlySet<string>;
	  };

function parseAuthAllow(raw: string): ParsedAllowlist {
	const users = new Set<string>();
	const orgs = new Set<string>();
	for (const segment of raw.split(",")) {
		const trimmed = segment.trim();
		if (trimmed === "") {
			continue;
		}
		const parts = trimmed.split(":");
		const expectedParts = 3;
		if (parts.length !== expectedParts) {
			throw new Error(
				`AUTH_ALLOW: malformed entry "${trimmed}" (expected provider:kind:id)`,
			);
		}
		const [provider, kind, id] = parts as [string, string, string];
		if (provider !== "github") {
			throw new Error(
				`AUTH_ALLOW: unknown provider "${provider}" in entry "${trimmed}"`,
			);
		}
		if (!ID_REGEX.test(id)) {
			throw new Error(
				`AUTH_ALLOW: invalid identifier "${id}" in entry "${trimmed}"`,
			);
		}
		if (kind === "user") {
			users.add(id);
		} else if (kind === "org") {
			orgs.add(id);
		} else {
			throw new Error(
				`AUTH_ALLOW: unknown kind "${kind}" in entry "${trimmed}"`,
			);
		}
	}
	return { users, orgs };
}

function parseAuth(raw: string | undefined): Auth {
	if (raw === undefined || raw === "") {
		return { mode: "disabled" };
	}
	if (raw === DISABLE_AUTH_SENTINEL) {
		return { mode: "open" };
	}
	// Reject sentinel appearing as one entry among others with a dedicated
	// message (clearer than the grammar error it would otherwise produce).
	for (const segment of raw.split(",")) {
		if (segment.trim() === DISABLE_AUTH_SENTINEL) {
			throw new Error(
				`AUTH_ALLOW sentinel "${DISABLE_AUTH_SENTINEL}" must be the only value`,
			);
		}
	}
	const parsed = parseAuthAllow(raw);
	return { mode: "restricted", users: parsed.users, orgs: parsed.orgs };
}

function allow(user: UserContext | undefined, auth: Auth): boolean {
	if (auth.mode === "open") {
		return true;
	}
	if (auth.mode === "disabled") {
		return false;
	}
	if (!user) {
		return false;
	}
	if (auth.users.has(user.name)) {
		return true;
	}
	for (const org of user.orgs) {
		if (auth.orgs.has(org)) {
			return true;
		}
	}
	return false;
}

export type { Auth, ParsedAllowlist };
export { allow, DISABLE_AUTH_SENTINEL, parseAuth, parseAuthAllow };
