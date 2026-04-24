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
