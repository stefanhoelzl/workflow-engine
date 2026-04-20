import { webcrypto } from "node:crypto";

// In-memory sealing password for all auth cookies (session, state, flash).
// Generated once at module load and never persisted anywhere. Every pod
// restart rolls the password, invalidating all existing cookies. This is
// the load-bearing invariant behind `replicas=1`: cookies sealed on pod A
// cannot be decrypted on pod B. See SECURITY.md §5.
//
// iron-webcrypto requires passwords of at least 32 characters. 32 random
// bytes hex-encoded is 64 chars.

const PASSWORD_BYTES = 32;
const HEX_RADIX = 16;
const HEX_PAD_LENGTH = 2;

function generatePassword(): string {
	const bytes = new Uint8Array(PASSWORD_BYTES);
	webcrypto.getRandomValues(bytes);
	return Array.from(bytes, (b) =>
		b.toString(HEX_RADIX).padStart(HEX_PAD_LENGTH, "0"),
	).join("");
}

const password = generatePassword();

export { password };
