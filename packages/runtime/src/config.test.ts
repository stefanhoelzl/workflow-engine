import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

const REQUIRED = {};

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

	it("parses GITHUB_USER as a restricted allow-list with one user", () => {
		const config = createConfig({ GITHUB_USER: "stefanhoelzl" });
		expect(config.githubAuth).toEqual({
			mode: "restricted",
			users: ["stefanhoelzl"],
		});
	});

	it("resolves to disabled mode when GITHUB_USER is not provided", () => {
		const config = createConfig({});
		expect(config.githubAuth).toEqual({ mode: "disabled" });
	});

	it("parses a comma-separated GITHUB_USER into multiple users", () => {
		const config = createConfig({ GITHUB_USER: "alice,bob" });
		expect(config.githubAuth).toEqual({
			mode: "restricted",
			users: ["alice", "bob"],
		});
	});

	it("preserves whitespace and empty segments in GITHUB_USER", () => {
		const config = createConfig({ GITHUB_USER: "alice, bob,," });
		expect(config.githubAuth).toEqual({
			mode: "restricted",
			users: ["alice", " bob", "", ""],
		});
	});

	it("resolves to open mode when GITHUB_USER is the sentinel", () => {
		const config = createConfig({ GITHUB_USER: "__DISABLE_AUTH__" });
		expect(config.githubAuth).toEqual({ mode: "open" });
	});

	it("rejects GITHUB_USER when sentinel is mixed with usernames", () => {
		expect(() =>
			createConfig({ GITHUB_USER: "alice,__DISABLE_AUTH__" }),
		).toThrow("must be the only value");
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
		expect(config.persistenceS3AccessKeyId).toBe("key");
		expect(config.persistenceS3SecretAccessKey).toBe("secret");
		expect(config.persistenceS3Endpoint).toBe("http://minio:9000");
		expect(config.persistenceS3Region).toBe("eu-central-1");
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
