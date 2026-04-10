import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

const REQUIRED = {};

describe("createConfig", () => {
	it("parses valid values", () => {
		const config = createConfig({
			...REQUIRED,
			// biome-ignore lint/style/useNamingConvention: env var name
			LOG_LEVEL: "debug",
			// biome-ignore lint/style/useNamingConvention: env var name
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
		// biome-ignore lint/style/useNamingConvention: env var name
		const config = createConfig({ ...REQUIRED, PORT: "9090" });
		expect(config.port).toBe(9090);
		expect(config.logLevel).toBe("info");
	});

	it("rejects invalid log level", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		expect(() => createConfig({ ...REQUIRED, LOG_LEVEL: "verbose" })).toThrow();
	});

	it("rejects non-numeric port", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		expect(() => createConfig({ ...REQUIRED, PORT: "abc" })).toThrow();
	});

	it("parses GITHUB_USER when provided", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		const config = createConfig({ GITHUB_USER: "stefanhoelzl" });
		expect(config.githubUser).toBe("stefanhoelzl");
	});

	it("GITHUB_USER is undefined when not provided", () => {
		const config = createConfig({});
		expect(config.githubUser).toBeUndefined();
	});

	it("parses S3 config fields", () => {
		const config = createConfig({
			...REQUIRED,
			// biome-ignore lint/style/useNamingConvention: env var name
			PERSISTENCE_S3_BUCKET: "my-bucket",
			// biome-ignore lint/style/useNamingConvention: env var name
			PERSISTENCE_S3_ACCESS_KEY_ID: "key",
			// biome-ignore lint/style/useNamingConvention: env var name
			PERSISTENCE_S3_SECRET_ACCESS_KEY: "secret",
			// biome-ignore lint/style/useNamingConvention: env var name
			PERSISTENCE_S3_ENDPOINT: "http://minio:9000",
			// biome-ignore lint/style/useNamingConvention: env var name
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
				// biome-ignore lint/style/useNamingConvention: env var name
				PERSISTENCE_S3_BUCKET: "my-bucket",
			}),
		).toThrow("requires PERSISTENCE_S3_ACCESS_KEY_ID and PERSISTENCE_S3_SECRET_ACCESS_KEY");
	});

	it("rejects both PERSISTENCE_PATH and PERSISTENCE_S3_BUCKET", () => {
		expect(() =>
			createConfig({
				...REQUIRED,
				// biome-ignore lint/style/useNamingConvention: env var name
				PERSISTENCE_PATH: "/data/events",
				// biome-ignore lint/style/useNamingConvention: env var name
				PERSISTENCE_S3_BUCKET: "my-bucket",
			}),
		).toThrow("mutually exclusive");
	});
});
