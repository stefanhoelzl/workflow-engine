import { defaults, type SealOptions, seal, unseal } from "iron-webcrypto";
import { password } from "./key.js";

interface SealedCookie<T> {
	seal(payload: T): Promise<string>;
	unseal(raw: string): Promise<T>;
}

function createSealedCookie<T>(ttlMs: number): SealedCookie<T> {
	const options: SealOptions = { ...defaults, ttl: ttlMs };
	return {
		seal: (payload) => seal(payload, password, options),
		unseal: async (raw) => (await unseal(raw, password, options)) as T,
	};
}

export type { SealedCookie };
export { createSealedCookie };
