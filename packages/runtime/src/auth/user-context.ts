interface UserContext {
	readonly login: string;
	readonly mail: string;
	readonly orgs: readonly string[];
}

declare module "hono" {
	interface ContextVariableMap {
		user: UserContext;
	}
}

export type { UserContext };
