import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createConfig, createSecret } from "./config.js";

const REQUIRED = {};
const RESTRICTED_REQS = {
	GITHUB_OAUTH_CLIENT_ID: "cid",
	GITHUB_OAUTH_CLIENT_SECRET: "csecret",
	BASE_URL: "https://example.test",
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

	it("resolves to disabled mode when AUTH_ALLOW is unset", () => {
		const config = createConfig({});
		expect(config.auth).toEqual({ mode: "disabled" });
	});

	it("resolves to disabled mode when AUTH_ALLOW is empty", () => {
		const config = createConfig({ AUTH_ALLOW: "" });
		expect(config.auth).toEqual({ mode: "disabled" });
	});

	it("resolves to open mode when AUTH_ALLOW is the sentinel", () => {
		const config = createConfig({ AUTH_ALLOW: "__DISABLE_AUTH__" });
		expect(config.auth).toEqual({ mode: "open" });
	});

	it("parses a single user entry into the restricted allow-list", () => {
		const config = createConfig({
			...RESTRICTED_REQS,
			AUTH_ALLOW: "github:user:stefanhoelzl",
		});
		expect(config.auth.mode).toBe("restricted");
		if (config.auth.mode === "restricted") {
			expect(config.auth.users).toEqual(new Set(["stefanhoelzl"]));
			expect(config.auth.orgs).toEqual(new Set());
		}
	});

	it("parses mixed user and org entries", () => {
		const config = createConfig({
			...RESTRICTED_REQS,
			AUTH_ALLOW: "github:user:alice,github:org:acme,github:user:bob",
		});
		expect(config.auth.mode).toBe("restricted");
		if (config.auth.mode === "restricted") {
			expect(config.auth.users).toEqual(new Set(["alice", "bob"]));
			expect(config.auth.orgs).toEqual(new Set(["acme"]));
		}
	});

	it("trims whitespace around entries and skips empty segments", () => {
		const config = createConfig({
			...RESTRICTED_REQS,
			AUTH_ALLOW: " github:user:alice ,  ,github:org:acme ",
		});
		if (config.auth.mode === "restricted") {
			expect(config.auth.users).toEqual(new Set(["alice"]));
			expect(config.auth.orgs).toEqual(new Set(["acme"]));
		}
	});

	it("rejects unknown provider", () => {
		expect(() =>
			createConfig({
				...RESTRICTED_REQS,
				AUTH_ALLOW: "google:user:alice",
			}),
		).toThrow(/unknown provider/);
	});

	it("rejects unknown kind", () => {
		expect(() =>
			createConfig({
				...RESTRICTED_REQS,
				AUTH_ALLOW: "github:team:acme-eng",
			}),
		).toThrow(/unknown kind/);
	});

	it("rejects invalid identifier", () => {
		expect(() =>
			createConfig({
				...RESTRICTED_REQS,
				AUTH_ALLOW: "github:user:has space",
			}),
		).toThrow(/invalid identifier/);
	});

	it("rejects malformed entry (missing segment)", () => {
		expect(() =>
			createConfig({
				...RESTRICTED_REQS,
				AUTH_ALLOW: "github:user",
			}),
		).toThrow(/malformed entry/);
	});

	it("rejects AUTH_ALLOW when sentinel is mixed with entries", () => {
		expect(() =>
			createConfig({
				...RESTRICTED_REQS,
				AUTH_ALLOW: "github:user:alice,__DISABLE_AUTH__",
			}),
		).toThrow(/must be the only value/);
	});

	it("requires GITHUB_OAUTH_CLIENT_ID when AUTH_ALLOW is restricted", () => {
		expect(() =>
			createConfig({
				AUTH_ALLOW: "github:user:alice",
				GITHUB_OAUTH_CLIENT_SECRET: "csecret",
				BASE_URL: "https://example.test",
			}),
		).toThrow(/GITHUB_OAUTH_CLIENT_ID/);
	});

	it("requires GITHUB_OAUTH_CLIENT_SECRET when AUTH_ALLOW is restricted", () => {
		expect(() =>
			createConfig({
				AUTH_ALLOW: "github:user:alice",
				GITHUB_OAUTH_CLIENT_ID: "cid",
				BASE_URL: "https://example.test",
			}),
		).toThrow(/GITHUB_OAUTH_CLIENT_SECRET/);
	});

	it("requires BASE_URL when AUTH_ALLOW is restricted", () => {
		expect(() =>
			createConfig({
				AUTH_ALLOW: "github:user:alice",
				GITHUB_OAUTH_CLIENT_ID: "cid",
				GITHUB_OAUTH_CLIENT_SECRET: "csecret",
			}),
		).toThrow(/BASE_URL/);
	});

	it("accepts restricted config with all required inputs", () => {
		const config = createConfig({
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
			AUTH_ALLOW: "github:user:alice",
			GITHUB_OAUTH_CLIENT_ID: "cid",
			GITHUB_OAUTH_CLIENT_SECRET: "supersecret",
			BASE_URL: "https://example.test",
		});
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain("supersecret");
		expect(serialized).toContain("[redacted]");
	});

	it("disabled mode does not require OAuth credentials", () => {
		const config = createConfig({});
		expect(config.auth).toEqual({ mode: "disabled" });
		expect(config.githubOauthClientId).toBeUndefined();
		expect(config.githubOauthClientSecret).toBeUndefined();
	});

	it("open mode does not require OAuth credentials", () => {
		const config = createConfig({ AUTH_ALLOW: "__DISABLE_AUTH__" });
		expect(config.auth).toEqual({ mode: "open" });
	});

	it("parses S3 config fields", () => {
		const config = createConfig({
			...REQUIRED,
			PERSISTENCE_S3_BUCKET: "my-bucket",
			PERSISTENCE_S3_ACCESS_KEY_ID: "key",
			PERSISTENCE_S3_SECRET_ACCESS_KEY: "secret",
			PERSISTENCE_S3_ENDPOINT: "http://minio:9000",
			PERSISTENCE_S3_REGION: "eu-central-1",
		});
		expect(config.persistenceS3Bucket).toBe("my-bucket");
		expect(config.persistenceS3AccessKeyId?.reveal()).toBe("key");
		expect(config.persistenceS3SecretAccessKey?.reveal()).toBe("secret");
		expect(config.persistenceS3Endpoint).toBe("http://minio:9000");
		expect(config.persistenceS3Region).toBe("eu-central-1");
	});

	it("redacts S3 credentials when the config is JSON-serialized", () => {
		const config = createConfig({
			...REQUIRED,
			PERSISTENCE_S3_BUCKET: "my-bucket",
			PERSISTENCE_S3_ACCESS_KEY_ID: "id123",
			PERSISTENCE_S3_SECRET_ACCESS_KEY: "supersecret",
		});
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain("id123");
		expect(serialized).not.toContain("supersecret");
		expect(serialized).toContain("[redacted]");
	});

	it("S3 fields are undefined when not provided", () => {
		const config = createConfig(REQUIRED);
		expect(config.persistenceS3Bucket).toBeUndefined();
		expect(config.persistenceS3AccessKeyId).toBeUndefined();
	});

	it("rejects S3 bucket without credentials", () => {
		expect(() =>
			createConfig({
				...REQUIRED,
				PERSISTENCE_S3_BUCKET: "my-bucket",
			}),
		).toThrow(
			"requires PERSISTENCE_S3_ACCESS_KEY_ID and PERSISTENCE_S3_SECRET_ACCESS_KEY",
		);
	});

	it("rejects both PERSISTENCE_PATH and PERSISTENCE_S3_BUCKET", () => {
		expect(() =>
			createConfig({
				...REQUIRED,
				PERSISTENCE_PATH: "/data/events",
				PERSISTENCE_S3_BUCKET: "my-bucket",
			}),
		).toThrow("mutually exclusive");
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
