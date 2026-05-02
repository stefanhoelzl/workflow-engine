import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createConfig, createSecret } from "./config.js";

// 32 bytes of base64 for a stub X25519 secret key used by SECRETS_PRIVATE_KEYS.
// createConfig does NOT decode or validate shape — that's key-store's concern;
// the config schema only stores the raw CSV inside a Secret wrapper.
const STUB_SK_B64 = "A".repeat(44);
const REQUIRED = {
	SECRETS_PRIVATE_KEYS: `k1:${STUB_SK_B64}`,
	PERSISTENCE_PATH: "/tmp/wfe-test",
};

describe("createConfig", () => {
	it("parses valid values", () => {
		const config = createConfig({
			...REQUIRED,
			LOG_LEVEL: "debug",
			PORT: "3000",
		});
		expect(config.logLevel).toBe("debug");
		expect(config.port).toBe(3000);
	});

	it("uses defaults for optional values", () => {
		const config = createConfig(REQUIRED);
		expect(config.logLevel).toBe("info");
		expect(config.port).toBe(8080);
		expect(config.fileIoConcurrency).toBe(10);
	});

	it("fills missing optional values with defaults", () => {
		const config = createConfig({ ...REQUIRED, PORT: "9090" });
		expect(config.port).toBe(9090);
		expect(config.logLevel).toBe("info");
	});

	it("rejects invalid log level", () => {
		expect(() => createConfig({ ...REQUIRED, LOG_LEVEL: "verbose" })).toThrow();
	});

	it("rejects non-numeric port", () => {
		expect(() => createConfig({ ...REQUIRED, PORT: "abc" })).toThrow();
	});

	it("SANDBOX_MAX_COUNT defaults to 10", () => {
		const config = createConfig(REQUIRED);
		expect(config.sandboxMaxCount).toBe(10);
	});

	it("SANDBOX_MAX_COUNT parses explicit positive integer", () => {
		const config = createConfig({ ...REQUIRED, SANDBOX_MAX_COUNT: "25" });
		expect(config.sandboxMaxCount).toBe(25);
	});

	it("SANDBOX_MAX_COUNT rejects non-numeric", () => {
		expect(() =>
			createConfig({ ...REQUIRED, SANDBOX_MAX_COUNT: "abc" }),
		).toThrow();
	});

	it("SANDBOX_MAX_COUNT rejects zero", () => {
		expect(() =>
			createConfig({ ...REQUIRED, SANDBOX_MAX_COUNT: "0" }),
		).toThrow();
	});

	it("SANDBOX_MAX_COUNT rejects negative", () => {
		expect(() =>
			createConfig({ ...REQUIRED, SANDBOX_MAX_COUNT: "-3" }),
		).toThrow();
	});

	it("SANDBOX_LIMIT_* fields default when env unset", () => {
		const config = createConfig(REQUIRED);
		expect(config.sandboxLimitMemoryBytes).toBe(67_108_864);
		expect(config.sandboxLimitStackBytes).toBe(524_288);
		expect(config.sandboxLimitCpuMs).toBe(60_000);
		expect(config.sandboxLimitOutputBytes).toBe(4_194_304);
		expect(config.sandboxLimitPendingCallables).toBe(64);
	});

	it("SANDBOX_LIMIT_CPU_MS honours env override", () => {
		const config = createConfig({ ...REQUIRED, SANDBOX_LIMIT_CPU_MS: "5000" });
		expect(config.sandboxLimitCpuMs).toBe(5000);
	});

	it("SANDBOX_LIMIT_MEMORY_BYTES rejects zero", () => {
		expect(() =>
			createConfig({ ...REQUIRED, SANDBOX_LIMIT_MEMORY_BYTES: "0" }),
		).toThrow();
	});

	it("SANDBOX_LIMIT_MEMORY_BYTES rejects negative", () => {
		expect(() =>
			createConfig({ ...REQUIRED, SANDBOX_LIMIT_MEMORY_BYTES: "-1" }),
		).toThrow();
	});

	it("SANDBOX_LIMIT_CPU_MS rejects non-numeric", () => {
		expect(() =>
			createConfig({ ...REQUIRED, SANDBOX_LIMIT_CPU_MS: "abc" }),
		).toThrow();
	});

	it("AUTH_ALLOW unset leaves authAllow undefined", () => {
		const config = createConfig(REQUIRED);
		expect(config.authAllow).toBeUndefined();
	});

	it("AUTH_ALLOW empty leaves authAllow as empty string", () => {
		const config = createConfig({ ...REQUIRED, AUTH_ALLOW: "" });
		expect(config.authAllow).toBe("");
	});

	it("passes AUTH_ALLOW through unparsed (registry build is downstream)", () => {
		const config = createConfig({
			...REQUIRED,
			AUTH_ALLOW: "github:user:alice,local:dev",
		});
		expect(config.authAllow).toBe("github:user:alice,local:dev");
	});

	it("LOCAL_DEPLOYMENT is exposed verbatim", () => {
		const config = createConfig({ ...REQUIRED, LOCAL_DEPLOYMENT: "1" });
		expect(config.localDeployment).toBe("1");
	});

	it("accepts github OAuth credentials when supplied", () => {
		const config = createConfig({
			...REQUIRED,
			AUTH_ALLOW: "github:user:alice",
			GITHUB_OAUTH_CLIENT_ID: "cid",
			GITHUB_OAUTH_CLIENT_SECRET: "csecret",
			BASE_URL: "https://example.test",
		});
		expect(config.githubOauthClientId).toBe("cid");
		expect(config.githubOauthClientSecret?.reveal()).toBe("csecret");
		expect(config.baseUrl).toBe("https://example.test");
	});

	it("redacts GITHUB_OAUTH_CLIENT_SECRET on JSON serialization", () => {
		const config = createConfig({
			...REQUIRED,
			AUTH_ALLOW: "github:user:alice",
			GITHUB_OAUTH_CLIENT_ID: "cid",
			GITHUB_OAUTH_CLIENT_SECRET: "supersecret",
			BASE_URL: "https://example.test",
		});
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain("supersecret");
		expect(serialized).toContain("[redacted]");
	});

	it("rejects missing PERSISTENCE_PATH", () => {
		expect(() =>
			createConfig({ SECRETS_PRIVATE_KEYS: `k1:${STUB_SK_B64}` }),
		).toThrow();
	});

	it("rejects missing SECRETS_PRIVATE_KEYS", () => {
		// Pins the fail-fast contract: `SECRETS_PRIVATE_KEYS` is required at
		// boot, not deferred to first decryption. Regressing this to
		// `.optional()` would let the runtime come up without a key-store
		// and fail later on upload.
		expect(() => createConfig({})).toThrow();
	});

	it("redacts SECRETS_PRIVATE_KEYS when the config is JSON-serialized", () => {
		const config = createConfig(REQUIRED);
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain(STUB_SK_B64);
		expect(serialized).toContain("[redacted]");
	});

	it("EVENT_STORE_* defaults apply when env vars are unset", () => {
		const config = createConfig(REQUIRED);
		expect(config.eventStoreCommitMaxRetries).toBe(5);
		expect(config.eventStoreCommitBackoffMs).toBe(500);
		expect(config.eventStoreSigtermFlushTimeoutMs).toBe(60_000);
	});

	it("EVENT_STORE_* env values override defaults", () => {
		const config = createConfig({
			...REQUIRED,
			EVENT_STORE_COMMIT_MAX_RETRIES: "2",
			EVENT_STORE_COMMIT_BACKOFF_MS: "100",
			EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS: "5000",
		});
		expect(config.eventStoreCommitMaxRetries).toBe(2);
		expect(config.eventStoreCommitBackoffMs).toBe(100);
		expect(config.eventStoreSigtermFlushTimeoutMs).toBe(5000);
	});

	it("EVENT_STORE_* rejects non-numeric values", () => {
		expect(() =>
			createConfig({
				...REQUIRED,
				EVENT_STORE_COMMIT_MAX_RETRIES: "not-a-number",
			}),
		).toThrow();
	});

	it("EVENT_STORE_* error names the offending field", () => {
		try {
			createConfig({
				...REQUIRED,
				EVENT_STORE_COMMIT_BACKOFF_MS: "abc",
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(String(err)).toContain("EVENT_STORE_COMMIT_BACKOFF_MS");
		}
	});
});

describe("createSecret", () => {
	it("reveals the captured value", () => {
		expect(createSecret("abc").reveal()).toBe("abc");
	});

	it("redacts via JSON.stringify", () => {
		expect(JSON.stringify(createSecret("abc"))).toBe('"[redacted]"');
	});

	it("redacts via String()", () => {
		expect(String(createSecret("abc"))).toBe("[redacted]");
	});

	it("redacts via template-literal interpolation", () => {
		expect(`${createSecret("abc")}`).toBe("[redacted]");
	});

	it("redacts via util.inspect", () => {
		expect(inspect(createSecret("abc"))).toBe("[redacted]");
	});

	it("does not leak the value when nested in a parent object", () => {
		const nested = { credential: createSecret("abc") };
		expect(JSON.stringify(nested)).toBe('{"credential":"[redacted]"}');
	});
});
