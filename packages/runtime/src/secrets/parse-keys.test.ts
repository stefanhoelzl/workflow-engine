import { describe, expect, it } from "vitest";
import {
	parseSecretsPrivateKeys,
	SECRET_KEY_BYTES,
	SecretsKeysParseError,
} from "./parse-keys.js";

function validSk(fill = 0x01): string {
	return Buffer.alloc(SECRET_KEY_BYTES, fill).toString("base64");
}

describe("parseSecretsPrivateKeys", () => {
	it("parses a single valid entry", () => {
		const parsed = parseSecretsPrivateKeys(`k1:${validSk(0x42)}`);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.keyId).toBe("k1");
		expect(parsed[0]?.sk).toHaveLength(SECRET_KEY_BYTES);
	});

	it("parses multiple entries in order (primary first)", () => {
		const csv = `k1:${validSk(1)},k2:${validSk(2)},k3:${validSk(3)}`;
		const parsed = parseSecretsPrivateKeys(csv);
		expect(parsed.map((p) => p.keyId)).toEqual(["k1", "k2", "k3"]);
	});

	it("trims whitespace around entries", () => {
		const csv = `  k1: ${validSk()} ,  k2: ${validSk(2)} `;
		const parsed = parseSecretsPrivateKeys(csv);
		expect(parsed.map((p) => p.keyId)).toEqual(["k1", "k2"]);
	});

	it("rejects empty input", () => {
		expect(() => parseSecretsPrivateKeys("")).toThrow(SecretsKeysParseError);
		expect(() => parseSecretsPrivateKeys("   ")).toThrow(SecretsKeysParseError);
	});

	it("rejects trailing comma / empty entry", () => {
		expect(() => parseSecretsPrivateKeys(`k1:${validSk()},`)).toThrow(
			SecretsKeysParseError,
		);
	});

	it("rejects entries missing the colon", () => {
		expect(() => parseSecretsPrivateKeys("bad-no-colon")).toThrow(
			SecretsKeysParseError,
		);
	});

	it("rejects entries with empty keyId", () => {
		expect(() => parseSecretsPrivateKeys(`:${validSk()}`)).toThrow(
			SecretsKeysParseError,
		);
	});

	it("rejects entries with empty base64", () => {
		expect(() => parseSecretsPrivateKeys("k1:")).toThrow(SecretsKeysParseError);
	});

	it("rejects duplicate keyIds", () => {
		const csv = `k1:${validSk(1)},k1:${validSk(2)}`;
		expect(() => parseSecretsPrivateKeys(csv)).toThrow(/duplicate/);
	});

	it("rejects wrong-length secret keys", () => {
		const shortKey = Buffer.alloc(16, 0xff).toString("base64");
		expect(() => parseSecretsPrivateKeys(`k1:${shortKey}`)).toThrow(
			/wrong secret-key length/,
		);
	});
});
