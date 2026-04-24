// X25519 secret keys are 32 bytes.
const SECRET_KEY_BYTES = 32;

interface ParsedKey {
	readonly keyId: string;
	readonly sk: Uint8Array;
}

class SecretsKeysParseError extends Error {
	constructor(message: string) {
		super(`SECRETS_PRIVATE_KEYS: ${message}`);
		this.name = "SecretsKeysParseError";
	}
}

function parseEntry(entry: string): ParsedKey {
	if (entry === "") {
		throw new SecretsKeysParseError("empty entry (check for trailing comma)");
	}
	const colon = entry.indexOf(":");
	if (colon < 0) {
		throw new SecretsKeysParseError(
			`malformed entry "${entry}" (expected "keyId:base64")`,
		);
	}
	const keyId = entry.slice(0, colon).trim();
	const b64 = entry.slice(colon + 1).trim();
	if (keyId === "") {
		throw new SecretsKeysParseError(
			`malformed entry "${entry}" (keyId is empty)`,
		);
	}
	if (b64 === "") {
		throw new SecretsKeysParseError(
			`malformed entry "${keyId}:..." (base64 secret key is empty)`,
		);
	}
	let sk: Uint8Array;
	try {
		sk = Uint8Array.from(Buffer.from(b64, "base64"));
	} catch {
		throw new SecretsKeysParseError(
			`malformed entry "${keyId}:..." (base64 decode failed)`,
		);
	}
	if (sk.length !== SECRET_KEY_BYTES) {
		throw new SecretsKeysParseError(
			`keyId "${keyId}" has wrong secret-key length ${String(
				sk.length,
			)} (expected ${String(SECRET_KEY_BYTES)})`,
		);
	}
	return { keyId, sk };
}

/**
 * Parses a `SECRETS_PRIVATE_KEYS` CSV:
 *   `keyId:base64(sk),keyId:base64(sk),...`
 *
 * Order-preserving: the first entry is the primary (active sealing) key.
 * Rejects empty input, malformed entries, and wrong-length secret keys.
 * Duplicate keyIds are rejected (ambiguous rotation state).
 */
function parseSecretsPrivateKeys(csv: string): readonly ParsedKey[] {
	const trimmed = csv.trim();
	if (trimmed === "") {
		throw new SecretsKeysParseError("value is empty");
	}
	const entries = trimmed.split(",").map((s) => s.trim());
	const seen = new Set<string>();
	const parsed: ParsedKey[] = [];
	for (const entry of entries) {
		const { keyId, sk } = parseEntry(entry);
		if (seen.has(keyId)) {
			throw new SecretsKeysParseError(`duplicate keyId "${keyId}"`);
		}
		seen.add(keyId);
		parsed.push({ keyId, sk });
	}
	return parsed;
}

export type { ParsedKey };
export { parseSecretsPrivateKeys, SECRET_KEY_BYTES, SecretsKeysParseError };
