// Public surface of `@workflow-engine/core/secrets-crypto`.
//
// Owns the only libsodium-wrappers consumers in the monorepo. Public exports
// hide the backing crypto library so callers depend on capability names
// (`sealCiphertext`, `unsealCiphertext`, `awaitCryptoReady`,
// `derivePublicKey`), not on `sodium.*`.
//
// MUST NOT be re-exported from `packages/core/src/index.ts` — the sandbox
// bundle resolves the main entry point and would otherwise pull libsodium.

// biome-ignore lint/performance/noBarrelFile: subpath entry — small, fixed surface, no fan-out concern; barrel here is the API contract
export { awaitCryptoReady } from "./await-crypto-ready.js";
export { derivePublicKey } from "./derive-public-key.js";
export type { Keypair } from "./generate-keypair.js";
export { generateKeypair } from "./generate-keypair.js";
export { sealCiphertext } from "./seal-ciphertext.js";
export { UnsealError, unsealCiphertext } from "./unseal-ciphertext.js";
