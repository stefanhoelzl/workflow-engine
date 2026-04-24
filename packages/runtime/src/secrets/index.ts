export type { ResolvedKey, SecretsKeyStore } from "./key-store.js";
// biome-ignore lint/performance/noBarrelFile: secrets module is intentionally exposed as a single subpath for consumers (runtime main.ts, executor, api layer); the tree is small and not on any perf-critical import chain
export {
	createKeyStore,
	decryptSealed,
	readySodium,
	SecretDecryptError,
	UnknownKeyIdError,
} from "./key-store.js";
export type { ParsedKey } from "./parse-keys.js";
export {
	parseSecretsPrivateKeys,
	SecretsKeysParseError,
} from "./parse-keys.js";
export type { SecretsVerifyFailure } from "./verify-manifest.js";
export { verifyManifestSecrets } from "./verify-manifest.js";
