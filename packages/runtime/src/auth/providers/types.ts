import type { Hono } from "hono";
import type { Child } from "hono/jsx";
import type { SessionPayload } from "../session-cookie.js";
import type { UserContext } from "../user-context.js";

interface ProviderRouteDeps {
	readonly secureCookies: boolean;
	readonly nowFn: () => number;
	readonly fetchFn?: typeof globalThis.fetch;
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly baseUrl?: string;
}

// `LoginSection` is a JSX subtree composed by the login page. Providers
// return a JSX node from `renderLoginSection`; the login page embeds it
// directly into its tree (no HtmlEscapedString concat).
type LoginSection = Child;

interface AuthProvider {
	readonly id: string;
	renderLoginSection(returnTo: string): LoginSection;
	mountAuthRoutes(subApp: Hono): void;
	resolveApiIdentity(req: Request): Promise<UserContext | undefined>;
	refreshSession(payload: SessionPayload): Promise<UserContext | undefined>;
}

interface AuthProviderFactory {
	readonly id: string;
	create(rawEntries: readonly string[], deps: ProviderRouteDeps): AuthProvider;
}

export type {
	AuthProvider,
	AuthProviderFactory,
	LoginSection,
	ProviderRouteDeps,
};
