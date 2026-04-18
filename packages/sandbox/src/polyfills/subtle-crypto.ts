// crypto.subtle validation + error-translation shim.
//
// The quickjs-wasi cryptoExtension installs crypto.subtle natively with
// synchronous methods that throw plain Error (often with PSA error codes).
// The Web Crypto spec requires Promise-returning methods that reject with
// specific DOMException types. This shim:
//   1. Captures the raw methods into the module closure.
//   2. Pre-validates arguments and rejects with the spec-mandated error
//      (TypeError for missing required dict members, DOMException of the
//      correct name for everything else) before the native impl is called.
//   3. Snapshots ArrayBuffer/ArrayBufferView inputs so a buffer detached
//      after the call starts surfaces as OperationError, not a generic
//      TypeError from the backend.
//   4. Wraps the call in a Promise so sync returns / throws both translate.
//   5. Post-translates surviving Errors (PSA error codes, generic impl
//      messages) into DOMException of the correct name.

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

// Per-algorithm allowed usages for generateKey. `mandatory` lists usages
// of which at least one must be present when the algorithm produces a
// private (or symmetric with mandatory) key; if `mandatory` is empty,
// an empty usages array is also allowed.
const GEN_KEY_RULES: Record<
	string,
	{ usages: readonly string[]; mandatory: readonly string[] }
> = {
	"AES-CBC": {
		usages: ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		mandatory: [],
	},
	"AES-CTR": {
		usages: ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		mandatory: [],
	},
	"AES-GCM": {
		usages: ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		mandatory: [],
	},
	"AES-KW": { usages: ["wrapKey", "unwrapKey"], mandatory: [] },
	HMAC: { usages: ["sign", "verify"], mandatory: [] },
	"RSA-OAEP": {
		usages: ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		mandatory: ["decrypt", "unwrapKey"],
	},
	"RSA-PSS": { usages: ["sign", "verify"], mandatory: ["sign"] },
	"RSASSA-PKCS1-v1_5": { usages: ["sign", "verify"], mandatory: ["sign"] },
	ECDSA: { usages: ["sign", "verify"], mandatory: ["sign"] },
	ECDH: {
		usages: ["deriveKey", "deriveBits"],
		mandatory: ["deriveKey", "deriveBits"],
	},
	Ed25519: { usages: ["sign", "verify"], mandatory: ["sign"] },
	X25519: {
		usages: ["deriveKey", "deriveBits"],
		mandatory: ["deriveKey", "deriveBits"],
	},
};

// Algorithms recognized by normalizeAlgo but that cannot be used with
// generateKey — import-only (key-derivation inputs) or digests.
const GEN_KEY_NOT_ALLOWED = new Set([
	"HKDF",
	"PBKDF2",
	"SHA-1",
	"SHA-256",
	"SHA-384",
	"SHA-512",
]);

// Per-algorithm allowed usages for importKey. Symmetric algorithms have
// a single allowlist regardless of format; asymmetric algorithms split
// by private/public, with format (and jwk-data shape) picking which slice.
const IMPORT_SYMMETRIC: Record<string, readonly string[]> = {
	"AES-CBC": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
	"AES-CTR": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
	"AES-GCM": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
	"AES-KW": ["wrapKey", "unwrapKey"],
	HMAC: ["sign", "verify"],
	HKDF: ["deriveKey", "deriveBits"],
	PBKDF2: ["deriveKey", "deriveBits"],
};

const IMPORT_ASYMMETRIC: Record<
	string,
	{ priv: readonly string[]; pub: readonly string[] }
> = {
	"RSA-OAEP": { priv: ["decrypt", "unwrapKey"], pub: ["encrypt", "wrapKey"] },
	"RSA-PSS": { priv: ["sign"], pub: ["verify"] },
	"RSASSA-PKCS1-v1_5": { priv: ["sign"], pub: ["verify"] },
	ECDSA: { priv: ["sign"], pub: ["verify"] },
	Ed25519: { priv: ["sign"], pub: ["verify"] },
	ECDH: { priv: ["deriveKey", "deriveBits"], pub: [] },
	X25519: { priv: ["deriveKey", "deriveBits"], pub: [] },
};

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

// True when `algorithm` is a dictionary (non-string, non-null object)
// without a `name` member — per WebIDL this is a missing required
// dictionary member and must throw a plain TypeError, not a DOMException.
function isEmptyAlgorithmDict(algorithm: unknown): boolean {
	return (
		algorithm != null &&
		typeof algorithm === "object" &&
		typeof (algorithm as { name?: unknown }).name !== "string"
	);
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

// A JWK-private key carries either `d` (EC/OKP) or `d`+`p`+`q` (RSA) or
// `k` (symmetric). For the public/private split, `d` is the discriminator
// upstream WPT uses (see importKey_failures.js `isPublicKey`).
function isJwkPrivate(data: unknown): boolean {
	if (!data || typeof data !== "object") {
		return false;
	}
	const d = data as Record<string, unknown>;
	return d.d !== undefined || d.priv !== undefined;
}

function allowedImportUsages(
	format: unknown,
	normalizedAlg: string,
	keyData: unknown,
): readonly string[] | null {
	const sym = IMPORT_SYMMETRIC[normalizedAlg];
	if (sym) {
		return sym;
	}
	const asym = IMPORT_ASYMMETRIC[normalizedAlg];
	if (!asym) {
		return null;
	}
	switch (format) {
		case "spki":
		case "raw":
		case "raw-public":
			return asym.pub;
		case "pkcs8":
		case "raw-private":
		case "raw-seed":
			return asym.priv;
		case "jwk":
			return isJwkPrivate(keyData) ? asym.priv : asym.pub;
		default:
			return null;
	}
}

function dom(name: string, message: string): DOMException {
	return new DOMException(message, name);
}

const notSupported = (m: string) => dom("NotSupportedError", m);
const invalidAccess = (m: string) => dom("InvalidAccessError", m);
const syntaxErr = (m: string) => dom("SyntaxError", m);
const dataErr = (m: string) => dom("DataError", m);
const operationErr = (m: string) => dom("OperationError", m);

// Shared: throw TypeError for `{}`, NotSupportedError for an unknown name.
// Returns the normalized algorithm name.
function requireNormalizedAlg(algorithm: unknown, label: string): string {
	if (isEmptyAlgorithmDict(algorithm)) {
		throw new TypeError(`${label}: algorithm.name is required`);
	}
	const name = algoName(algorithm);
	if (name == null) {
		throw notSupported(`${label}: missing algorithm.name`);
	}
	const normalized = normalizeAlgo(name);
	if (normalized == null) {
		throw notSupported(`${label}: unsupported algorithm ${name}`);
	}
	return normalized;
}

function validateDigest(args: unknown[]): void {
	const algorithm = args[0];
	if (isEmptyAlgorithmDict(algorithm)) {
		throw new TypeError("digest: algorithm.name is required");
	}
	const name = algoName(algorithm);
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
	if (isEmptyAlgorithmDict(algorithm)) {
		throw new TypeError("derive: algorithm.name is required");
	}
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
	if (isEmptyAlgorithmDict(derivedKeyType)) {
		throw new TypeError("deriveKey: derivedKeyType.name is required");
	}
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
	if (isEmptyAlgorithmDict(algorithm)) {
		throw new TypeError(`${usage}: algorithm.name is required`);
	}
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

function checkUsagesAllowed(
	usages: unknown,
	normalized: string,
	rules: { usages: readonly string[] } | undefined,
): void {
	if (!(rules && Array.isArray(usages))) {
		return;
	}
	for (const u of usages) {
		if (!rules.usages.includes(u as string)) {
			throw syntaxErr(`Bad usages: ${String(u)} not allowed for ${normalized}`);
		}
	}
}

const AES_ALGOS = new Set(["AES-CBC", "AES-CTR", "AES-GCM", "AES-KW"]);
const EC_ALGOS = new Set(["ECDH", "ECDSA"]);
const RSA_ALGOS = new Set(["RSA-OAEP", "RSA-PSS", "RSASSA-PKCS1-v1_5"]);

function checkAesLength(algorithm: unknown): void {
	const length = (algorithm as { length?: unknown }).length;
	if (length !== 128 && length !== 192 && length !== 256) {
		throw operationErr("AES length must be 128, 192, or 256");
	}
}

function checkHmacLength(algorithm: unknown): void {
	const length = (algorithm as { length?: unknown }).length;
	if (length !== undefined && (typeof length !== "number" || length === 0)) {
		throw operationErr("HMAC length must be > 0");
	}
}

function checkEcCurve(algorithm: unknown): void {
	const curve = (algorithm as { namedCurve?: unknown }).namedCurve;
	if (curve !== "P-256" && curve !== "P-384" && curve !== "P-521") {
		throw notSupported(`unsupported namedCurve: ${String(curve)}`);
	}
}

function checkRsaPublicExponent(algorithm: unknown): void {
	const exp = (algorithm as { publicExponent?: unknown }).publicExponent;
	if (!(exp instanceof Uint8Array)) {
		throw operationErr("RSA publicExponent must be a Uint8Array");
	}
	// WebCrypto mandates odd publicExponent ≥ 3. Common valid values are 3
	// ([0x03]) and 65537 ([0x01,0x00,0x01]); anything even or equal to 1 is
	// an error. Bitwise shifts on BigInt are the idiomatic way to parse a
	// byte sequence as an unsigned integer.
	let bi = 0n;
	for (const b of exp) {
		// biome-ignore lint/suspicious/noBitwiseOperators: parsing Uint8Array bytes as BigInt
		bi = (bi << 8n) | BigInt(b);
	}
	// biome-ignore lint/suspicious/noBitwiseOperators: parity check on BigInt
	if (bi < 3n || (bi & 1n) === 0n) {
		throw operationErr("RSA publicExponent must be an odd integer ≥ 3");
	}
}

// Checks algorithm-property ranges (length, namedCurve, publicExponent) per
// WebCrypto spec. Assigns OperationError (or NotSupportedError for EC
// namedCurve, per spec exception).
function checkGenAlgorithmProperties(
	normalized: string,
	algorithm: unknown,
): void {
	if (AES_ALGOS.has(normalized)) {
		checkAesLength(algorithm);
	} else if (normalized === "HMAC") {
		checkHmacLength(algorithm);
	} else if (EC_ALGOS.has(normalized)) {
		checkEcCurve(algorithm);
	} else if (RSA_ALGOS.has(normalized)) {
		checkRsaPublicExponent(algorithm);
	}
}

// Per WebCrypto spec, the per-algorithm "generate key" operation runs
// this order:
//   1. If usages contains entries outside the allowed set → SyntaxError
//   2. If algorithm params (length, modulusLength, …) are invalid → OperationError
//   3. If usages is empty but a mandatory usage is required → SyntaxError
// WPT's failures.js confirms this order exactly.
function validateGenerateKey(args: unknown[]): void {
	const algorithm = args[0];
	const usages = args[2];
	const normalized = requireNormalizedAlg(algorithm, "generateKey");
	if (GEN_KEY_NOT_ALLOWED.has(normalized)) {
		throw notSupported(`generateKey not supported for ${normalized}`);
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

	const rules = GEN_KEY_RULES[normalized];
	checkUsagesAllowed(usages, normalized, rules);
	checkGenAlgorithmProperties(normalized, algorithm);

	// Empty usages check — spec places this after property validation for
	// algorithms with mandatory usages (all asymmetric + none symmetric).
	if (
		rules &&
		rules.mandatory.length > 0 &&
		Array.isArray(usages) &&
		usages.length === 0
	) {
		throw syntaxErr(`Empty usages not allowed for ${normalized}`);
	}
}

function validateImportKey(args: unknown[]): void {
	const format = args[0];
	const keyData = args[1];
	const algorithm = args[2];
	const usages = args[4];

	const normalized = requireNormalizedAlg(algorithm, "importKey");

	if (!Array.isArray(usages)) {
		return;
	}

	const allowed = allowedImportUsages(format, normalized, keyData);
	if (allowed === null) {
		return;
	}

	for (const u of usages) {
		if (!allowed.includes(u as string)) {
			throw syntaxErr(`Bad usages: ${String(u)} not allowed for ${normalized}`);
		}
	}

	// Private-key formats require a non-empty usages list for asymmetric
	// algorithms. Symmetric imports always accept empty usages per spec.
	if (usages.length === 0 && IMPORT_ASYMMETRIC[normalized]) {
		const isPrivateFormat =
			format === "pkcs8" ||
			format === "raw-private" ||
			format === "raw-seed" ||
			(format === "jwk" && isJwkPrivate(keyData));
		if (isPrivateFormat) {
			throw syntaxErr(`Empty usages not allowed for private ${normalized} key`);
		}
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

// Methods whose input buffers should be snapshotted at call-start, per
// WebCrypto spec: "read the bytes of the input". If the caller detaches
// the buffer between await points, the operation still sees the pre-detach
// bytes. Also: passing an already-detached buffer is OperationError, not
// a raw TypeError.
const SNAPSHOT_METHODS = new Set<Method>([
	"digest",
	"encrypt",
	"decrypt",
	"sign",
	"verify",
]);

// Argument index of the data buffer for each snapshot method (WebCrypto
// signatures put the buffer last). Covers digest(alg, data), (en|de)crypt(
// alg, key, data), sign/verify(alg, key, [sig], data).
function snapshotBuffer(method: Method, args: unknown[]): void {
	if (method === "digest") {
		args[1] = copyBuffer(args[1], method);
		return;
	}
	if (method === "encrypt" || method === "decrypt" || method === "sign") {
		args[2] = copyBuffer(args[2], method);
		return;
	}
	if (method === "verify") {
		args[2] = copyBuffer(args[2], method);
		args[3] = copyBuffer(args[3], method);
	}
}

function copyBuffer(data: unknown, method: Method): unknown {
	if (data == null) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		if (isDetached(data)) {
			throw operationErr(`${method}: input buffer is detached`);
		}
		return data.slice(0);
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		const underlying = view.buffer as ArrayBuffer;
		if (isDetached(underlying)) {
			throw operationErr(`${method}: input buffer is detached`);
		}
		const copy = new Uint8Array(view.byteLength);
		copy.set(new Uint8Array(underlying, view.byteOffset, view.byteLength));
		return copy;
	}
	return data;
}

function isDetached(buf: ArrayBuffer): boolean {
	// Accessing `.byteLength` on a detached ArrayBuffer returns 0 on every
	// engine; non-detached buffers can also be empty, but on a detached
	// buffer `new Uint8Array(buf)` throws TypeError. That's the only robust
	// cross-engine probe.
	if (buf.byteLength > 0) {
		return false;
	}
	try {
		new Uint8Array(buf);
		return false;
	} catch {
		return true;
	}
}

const RE_PSA_149 = /PSA error -149/;
const RE_PSA_13X = /PSA error -13[3-7]/;
const RE_BAD_HASH =
	/bad\s+hash\s+name|Unrecognized\s+algorithm\s+name\s+for\s+digest/i;
const RE_UNSUPPORTED =
	/Unsupported\s+algorithm|Bad\s+algorithm\s+not\s+supported|not\s+supported|Unrecognized\s+algorithm/i;
const RE_BAD_USAGES = /Invalid\s+key\s+usages|Bad\s+usages/i;
const RE_KEY_ACCESS =
	/baseKey\s+must\s+be\s+a\s+CryptoKey|wrong\s+\(.*\)\s+key|missing\s+derive(Key|Bits)|mismatched\s+algorithms/i;
const RE_KEY_DATA =
	/Invalid\s+key\s+data|Invalid\s+.*\s+key|key\s+length|key\s+size|malformed/i;
const RE_DETACHED = /ArrayBuffer\s+is\s+detached|detached\s+ArrayBuffer/i;

// Method-scoped fallbacks: once pre-dispatch validation passes, backend
// errors map to the single class the spec reserves for "this method's
// algorithm-specific step failed". `importKey` → DataError (bad key bytes);
// the crypto operations → OperationError.
const FALLBACK_OPERATION_METHODS = new Set<Method>([
	"generateKey",
	"deriveKey",
	"deriveBits",
	"sign",
	"verify",
	"encrypt",
	"decrypt",
]);

function translateByMessage(msg: string): DOMException | null {
	if (RE_PSA_149.test(msg) || RE_DETACHED.test(msg)) {
		return operationErr(msg);
	}
	if (RE_BAD_HASH.test(msg) || RE_UNSUPPORTED.test(msg)) {
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
	return null;
}

function translateError(method: Method, err: unknown): unknown {
	if (err instanceof DOMException) {
		return err;
	}
	if (!(err instanceof Error)) {
		return err;
	}
	const msg = err.message || "";
	const byMsg = translateByMessage(msg);
	if (byMsg) {
		return byMsg;
	}
	// importKey: PSA-13x at this seam means bad key bytes — DataError.
	// Crypto ops: PSA-13x means operation failed — OperationError.
	if (method === "importKey") {
		return dataErr(msg);
	}
	if (FALLBACK_OPERATION_METHODS.has(method)) {
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
	const shouldSnapshot = SNAPSHOT_METHODS.has(method);
	const wrapped = (...args: unknown[]): Promise<unknown> => {
		try {
			validate(args);
			if (shouldSnapshot) {
				snapshotBuffer(method, args);
			}
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
