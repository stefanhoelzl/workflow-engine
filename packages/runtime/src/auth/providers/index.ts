import { githubProviderFactory } from "./github.js";
import { localProviderFactory } from "./local.js";
import type { AuthProviderFactory } from "./types.js";

function buildProviderFactories(
	env: Record<string, string | undefined>,
): readonly AuthProviderFactory[] {
	const factories: AuthProviderFactory[] = [githubProviderFactory];
	if (env.LOCAL_DEPLOYMENT === "1") {
		factories.push(localProviderFactory);
	}
	return factories;
}

export type { ProviderRegistry } from "./registry.js";
// biome-ignore lint/performance/noBarrelFile: small re-export surface for the auth-providers public API
export { buildRegistry } from "./registry.js";
export type {
	AuthProvider,
	AuthProviderFactory,
	LoginSection,
	ProviderRouteDeps,
} from "./types.js";
export { buildProviderFactories };
