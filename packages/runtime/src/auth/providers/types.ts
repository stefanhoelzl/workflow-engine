import type { Hono } from "hono";
import type { HtmlEscapedString } from "hono/utils/html";
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

type LoginSection = HtmlEscapedString | Promise<HtmlEscapedString>;

interface AuthProvider {
	readonly id: string;
	renderLoginSection(returnTo: string): LoginSection;
	mountAuthRoutes(subApp: Hono): void;
	resolveApiIdentity(req: Request): Promise<UserContext | undefined>;
	refreshSession(payload: SessionPayload): Promise<UserContext | undefined>;

	// Optional provider-supplied addenda rendered on /login when a flash
	// (denied or logged-out) is attributed to this provider:
	//   - renderFlashBody: appended into the banner body, after the generic copy
	//   - renderFlashAction: appended into the action area, below the provider
	//                        login sections (e.g., "Sign out of GitHub")
	// Local provider omits both — sessionless local sign-out has no IdP to mention.
	renderFlashBody?(): LoginSection;
	renderFlashAction?(): LoginSection;
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
