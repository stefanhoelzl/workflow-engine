import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

// biome-ignore lint/style/useNamingConvention: env var name
const REQUIRED = { WORKFLOW_DIR: "/tmp/workflows" };

describe("createConfig", () => {
	it("parses valid values", () => {
		const config = createConfig({
			...REQUIRED,
			// biome-ignore lint/style/useNamingConvention: env var name
			LOG_LEVEL: "debug",
			// biome-ignore lint/style/useNamingConvention: env var name
			PORT: "3000",
		});
		expect(config).toEqual({ logLevel: "debug", port: 3000, fileIoConcurrency: 10, workflowDir: "/tmp/workflows" });
	});

	it("uses defaults for optional values", () => {
		const config = createConfig(REQUIRED);
		expect(config).toEqual({ logLevel: "info", port: 8080, fileIoConcurrency: 10, workflowDir: "/tmp/workflows" });
	});

	it("fills missing optional values with defaults", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		const config = createConfig({ ...REQUIRED, PORT: "9090" });
		expect(config).toEqual({ logLevel: "info", port: 9090, fileIoConcurrency: 10, workflowDir: "/tmp/workflows" });
	});

	it("rejects invalid log level", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		expect(() => createConfig({ ...REQUIRED, LOG_LEVEL: "verbose" })).toThrow();
	});

	it("rejects non-numeric port", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		expect(() => createConfig({ ...REQUIRED, PORT: "abc" })).toThrow();
	});

	it("requires WORKFLOW_DIR", () => {
		expect(() => createConfig({})).toThrow();
	});
});
