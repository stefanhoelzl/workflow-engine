// crypto.subtle validation + error-translation shim.
//
// The quickjs-wasi cryptoExtension installs crypto.subtle natively with
// synchronous methods that throw plain Error (often with PSA error codes).
// The Web Crypto spec requires Promise-returning methods that reject with
// specific DOMException types. This shim:
//   1. Captures the raw methods into the module closure.
//   2. Pre-validates arguments (hash name, algorithm name, key usages,
//      base-key algorithm match) and rejects with the spec-mandated
//      DOMException before the native impl is ever called.
//   3. Wraps the call in a Promise so sync returns / throws both translate.
//   4. Post-translates surviving Errors (PSA error codes, generic impl
//      messages) into DOMException of the correct name.
//   5. Rewraps each method on crypto.subtle in place — the subtle object
//      itself is installed non-configurable by the cryptoExtension, but its
//      method properties are writable, so per-method assignment is the only
//      portable way to shim this surface.

type Algorithm = string | { name: string; [k: string]: unknown };

interface KeyLike {
	type: string;
	extractable: boolean;
	algorithm: { name: string; [k: string]: unknown };
	usages: string[];
}

const HASH_SET = new Set(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);

const SUPPORTED_ALGORITHMS = new Set([
	"AES-CBC",
	"AES-CTR",
	"AES-GCM",
	"AES-KW",
	"HMAC",
	"HKDF",
	"PBKDF2",
	"ECDH",
	"ECDSA",
	"RSA-OAEP",
	"RSA-PSS",
	"RSASSA-PKCS1-v1_5",
	"SHA-1",
	"SHA-256",
	"SHA-384",
	"SHA-512",
	"X25519",
	"Ed25519",
]);

const DERIVE_ALGORITHMS = new Set(["HKDF", "PBKDF2", "ECDH", "X25519", "X448"]);

function algoName(algorithm: unknown): string | null {
	if (typeof algorithm === "string") {
		return algorithm;
	}
	if (
		algorithm &&
		typeof algorithm === "object" &&
		typeof (algorithm as { name?: unknown }).name === "string"
	) {
		return (algorithm as { name: string }).name;
	}
	return null;
}

function normalizeAlgo(raw: string | null): string | null {
	if (raw == null) {
		return null;
	}
	const upper = raw.toUpperCase();
	for (const name of SUPPORTED_ALGORITHMS) {
		if (name.toUpperCase() === upper) {
			return name;
		}
	}
	return null;
}

function hashNameFrom(algorithm: Algorithm): unknown {
	if (typeof algorithm === "string") {
		return;
	}
	return (algorithm as { hash?: unknown }).hash;
}

function isValidHashName(hash: unknown): boolean {
	const name = algoName(hash);
	if (name == null) {
		return false;
	}
	const upper = name.toUpperCase();
	for (const h of HASH_SET) {
		if (h.toUpperCase() === upper) {
			return true;
		}
	}
	return false;
}

function isCryptoKey(x: unknown): x is KeyLike {
	if (x == null || typeof x !== "object") {
		return false;
	}
	const o = x as Record<string, unknown>;
	if (typeof o.type !== "string") {
		return false;
	}
	if (typeof o.extractable !== "boolean") {
		return false;
	}
	if (!Array.isArray(o.usages)) {
		return false;
	}
	const alg = o.algorithm as { name?: unknown } | null | undefined;
	if (!alg || typeof alg !== "object" || typeof alg.name !== "string") {
		return false;
	}
	return true;
}

function dom(name: string, message: string): DOMException {
	return new DOMException(message, name);
}

const notSupported = (m: string) => dom("NotSupportedError", m);
const invalidAccess = (m: string) => dom("InvalidAccessError", m);
const syntaxErr = (m: string) => dom("SyntaxError", m);
const dataErr = (m: string) => dom("DataError", m);
const operationErr = (m: string) => dom("OperationError", m);

function validateDigest(args: unknown[]): void {
	const name = algoName(args[0]);
	if (!isValidHashName(name)) {
		throw notSupported(`Unrecognized digest algorithm: ${String(name)}`);
	}
}

function validateDeriveCommon(
	args: unknown[],
	usage: "deriveKey" | "deriveBits",
): void {
	const algorithm = args[0];
	const baseKey = args[1];
	const name = algoName(algorithm);
	if (name == null) {
		throw notSupported("Missing algorithm.name");
	}
	const normalized = normalizeAlgo(name);
	if (normalized == null || !DERIVE_ALGORITHMS.has(normalized)) {
		if (name === "X448" || name === "Ed448") {
			throw notSupported(`${name} not supported`);
		}
		throw notSupported(`Unrecognized derive algorithm: ${name}`);
	}
	// Spec: algorithm normalization (inner hash included) happens before
	// baseKey type/algorithm/usage checks.
	if (normalized === "HKDF" || normalized === "PBKDF2") {
		const hash = hashNameFrom(algorithm as Algorithm);
		if (!isValidHashName(hash)) {
			throw notSupported(`bad hash name: ${String(algoName(hash))}`);
		}
	}
	if (!isCryptoKey(baseKey)) {
		throw invalidAccess("baseKey must be a CryptoKey");
	}
	if (baseKey.algorithm.name !== normalized) {
		throw invalidAccess(
			`wrong (${baseKey.algorithm.name}) key for ${normalized}`,
		);
	}
	if (!baseKey.usages.includes(usage)) {
		throw invalidAccess(`missing ${usage} usage for base key`);
	}
}

function validateDeriveKey(args: unknown[]): void {
	validateDeriveCommon(args, "deriveKey");
	const derivedKeyType = args[2];
	const derivedName = algoName(derivedKeyType);
	if (derivedName == null) {
		throw notSupported("Missing derivedKeyType.name");
	}
	const norm = normalizeAlgo(derivedName);
	if (norm == null) {
		throw notSupported(`Unrecognized derivedKeyType: ${derivedName}`);
	}
	if (norm === "HMAC") {
		const hash = hashNameFrom(derivedKeyType as Algorithm);
		if (!isValidHashName(hash)) {
			throw notSupported(`bad hash name: ${String(algoName(hash))}`);
		}
	}
}

function validateDeriveBits(args: unknown[]): void {
	validateDeriveCommon(args, "deriveBits");
}

function validateKeyOp(
	args: unknown[],
	usage: "encrypt" | "decrypt" | "sign" | "verify",
): void {
	const algorithm = args[0];
	const key = args[1];
	const name = algoName(algorithm);
	if (name == null) {
		throw notSupported("Missing algorithm.name");
	}
	const normalized = normalizeAlgo(name);
	if (normalized == null) {
		throw notSupported(`Unrecognized algorithm: ${name}`);
	}
	if (
		normalized === "HMAC" ||
		normalized === "RSA-PSS" ||
		normalized === "RSA-OAEP" ||
		normalized === "RSASSA-PKCS1-v1_5"
	) {
		const hash = hashNameFrom(algorithm as Algorithm);
		if (hash !== undefined && !isValidHashName(hash)) {
			throw notSupported(`bad hash name: ${String(algoName(hash))}`);
		}
	}
	if (normalized === "ECDSA") {
		const hash = hashNameFrom(algorithm as Algorithm);
		if (!isValidHashName(hash)) {
			throw notSupported(`bad hash name: ${String(algoName(hash))}`);
		}
	}
	if (!isCryptoKey(key)) {
		throw invalidAccess("key must be a CryptoKey");
	}
	if (key.algorithm.name !== normalized) {
		throw invalidAccess(`wrong (${key.algorithm.name}) key for ${normalized}`);
	}
	if (!key.usages.includes(usage)) {
		throw invalidAccess(`missing ${usage} usage for key`);
	}
}

function validateGenerateKey(args: unknown[]): void {
	const algorithm = args[0];
	const name = algoName(algorithm);
	if (name == null) {
		throw notSupported("Missing algorithm.name");
	}
	const normalized = normalizeAlgo(name);
	if (normalized == null) {
		throw notSupported(`Bad algorithm not supported: ${name}`);
	}
	if (
		normalized === "HMAC" ||
		normalized === "RSA-OAEP" ||
		normalized === "RSA-PSS" ||
		normalized === "RSASSA-PKCS1-v1_5"
	) {
		const hash = hashNameFrom(algorithm as Algorithm);
		if (!isValidHashName(hash)) {
			throw notSupported(`bad hash name: ${String(algoName(hash))}`);
		}
	}
}

function validateImportKey(args: unknown[]): void {
	const algorithm = args[2];
	const name = algoName(algorithm);
	if (name == null) {
		throw notSupported("Missing algorithm.name");
	}
	const normalized = normalizeAlgo(name);
	if (normalized == null) {
		throw notSupported(`Unsupported algorithm for importKey: ${name}`);
	}
}

function validateExportKey(args: unknown[]): void {
	const key = args[1];
	if (!isCryptoKey(key)) {
		throw invalidAccess("key must be a CryptoKey");
	}
	if (!key.extractable) {
		throw invalidAccess("key is not extractable");
	}
}

function validateWrapKey(args: unknown[]): void {
	const key = args[1];
	const wrappingKey = args[2];
	if (!isCryptoKey(key)) {
		throw invalidAccess("key must be a CryptoKey");
	}
	if (!key.extractable) {
		throw invalidAccess("key is not extractable");
	}
	if (!isCryptoKey(wrappingKey)) {
		throw invalidAccess("wrappingKey must be a CryptoKey");
	}
	if (!wrappingKey.usages.includes("wrapKey")) {
		throw invalidAccess("missing wrapKey usage for wrappingKey");
	}
}

function validateUnwrapKey(args: unknown[]): void {
	const unwrappingKey = args[3];
	if (!isCryptoKey(unwrappingKey)) {
		throw invalidAccess("unwrappingKey must be a CryptoKey");
	}
	if (!unwrappingKey.usages.includes("unwrapKey")) {
		throw invalidAccess("missing unwrapKey usage for unwrappingKey");
	}
}

type Method =
	| "digest"
	| "importKey"
	| "exportKey"
	| "sign"
	| "verify"
	| "encrypt"
	| "decrypt"
	| "generateKey"
	| "deriveBits"
	| "deriveKey"
	| "wrapKey"
	| "unwrapKey";

const VALIDATORS: Record<Method, (args: unknown[]) => void> = {
	digest: validateDigest,
	importKey: validateImportKey,
	exportKey: validateExportKey,
	sign: (args) => validateKeyOp(args, "sign"),
	verify: (args) => validateKeyOp(args, "verify"),
	encrypt: (args) => validateKeyOp(args, "encrypt"),
	decrypt: (args) => validateKeyOp(args, "decrypt"),
	generateKey: validateGenerateKey,
	deriveBits: validateDeriveBits,
	deriveKey: validateDeriveKey,
	wrapKey: validateWrapKey,
	unwrapKey: validateUnwrapKey,
};

const RE_PSA_149 = /PSA error -149/;
const RE_PSA_135 = /PSA error -135/;
const RE_PSA_13X = /PSA error -13[3-7]/;
const RE_BAD_HASH =
	/bad\s+hash\s+name|Unrecognized\s+algorithm\s+name\s+for\s+digest/i;
const RE_UNSUPPORTED =
	/Unsupported\s+algorithm|Bad\s+algorithm\s+not\s+supported|not\s+supported|Unrecognized\s+algorithm/i;
const RE_BAD_USAGES = /Invalid\s+key\s+usages|Bad\s+usages/i;
const RE_KEY_ACCESS =
	/baseKey\s+must\s+be\s+a\s+CryptoKey|wrong\s+\(.*\)\s+key|missing\s+derive(Key|Bits)|mismatched\s+algorithms/i;
const RE_KEY_DATA = /Invalid\s+key\s+data|Invalid\s+.*\s+key/i;

function translateError(method: Method, err: unknown): unknown {
	if (err instanceof DOMException) {
		return err;
	}
	if (!(err instanceof Error)) {
		return err;
	}
	const msg = err.message || "";

	if (RE_PSA_149.test(msg)) {
		return operationErr(msg);
	}
	if (RE_BAD_HASH.test(msg)) {
		return notSupported(msg);
	}
	if (RE_UNSUPPORTED.test(msg)) {
		return notSupported(msg);
	}
	if (RE_BAD_USAGES.test(msg)) {
		return syntaxErr(msg);
	}
	if (RE_KEY_ACCESS.test(msg)) {
		return invalidAccess(msg);
	}
	if (RE_KEY_DATA.test(msg)) {
		return dataErr(msg);
	}
	if (method === "importKey" && RE_PSA_135.test(msg)) {
		return err;
	}
	if (
		(method === "deriveKey" ||
			method === "deriveBits" ||
			method === "sign" ||
			method === "verify" ||
			method === "encrypt" ||
			method === "decrypt") &&
		RE_PSA_13X.test(msg)
	) {
		return operationErr(msg);
	}
	return err;
}

const METHODS: Method[] = [
	"digest",
	"importKey",
	"exportKey",
	"sign",
	"verify",
	"encrypt",
	"decrypt",
	"generateKey",
	"deriveBits",
	"deriveKey",
	"wrapKey",
	"unwrapKey",
];

const subtle = crypto.subtle as unknown as Record<
	Method,
	(...args: unknown[]) => unknown
>;

for (const method of METHODS) {
	const fn = subtle[method].bind(subtle);
	const validate = VALIDATORS[method];
	const wrapped = (...args: unknown[]): Promise<unknown> => {
		try {
			validate(args);
		} catch (e) {
			return Promise.reject(e);
		}
		let result: unknown;
		try {
			result = fn(...args);
		} catch (e) {
			return Promise.reject(translateError(method, e));
		}
		return Promise.resolve(result).catch((e: unknown) => {
			throw translateError(method, e);
		});
	};
	subtle[method] = wrapped;
}
