interface UserContext {
	readonly name: string;
	readonly mail: string;
	readonly orgs: readonly string[];
	readonly teams: readonly string[];
}

declare module "hono" {
	interface ContextVariableMap {
		user: UserContext;
		// Set by `/api/*` middleware when auth mode is `open` (dev-only).
		// Signals that membership checks should be skipped. The regex-based
		// tenant-identifier validation in handlers is NOT skipped.
		authOpen: boolean;
	}
}

export type { UserContext };
