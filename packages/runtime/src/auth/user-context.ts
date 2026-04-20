interface UserContext {
	readonly name: string;
	readonly mail: string;
	readonly orgs: readonly string[];
}

declare module "hono" {
	interface ContextVariableMap {
		user: UserContext;
		// Set by `/api/*` Bearer middleware and the `/dashboard` and `/trigger`
		// session middleware when `auth.mode === "open"`. Signals that
		// membership checks should be skipped. The regex-based tenant-
		// identifier validation in handlers is NOT skipped.
		authOpen: boolean;
	}
}

export type { UserContext };
