import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

describe("createConfig", () => {
	it("parses valid values", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		const config = createConfig({ LOG_LEVEL: "debug", PORT: "3000" });
		expect(config).toEqual({ logLevel: "debug", port: 3000, fileIoConcurrency: 10 });
	});

	it("uses defaults for empty env", () => {
		const config = createConfig({});
		expect(config).toEqual({ logLevel: "info", port: 8080, fileIoConcurrency: 10 });
	});

	it("fills missing values with defaults", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		const config = createConfig({ PORT: "9090" });
		expect(config).toEqual({ logLevel: "info", port: 9090, fileIoConcurrency: 10 });
	});

	it("rejects invalid log level", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		expect(() => createConfig({ LOG_LEVEL: "verbose" })).toThrow();
	});

	it("rejects non-numeric port", () => {
		// biome-ignore lint/style/useNamingConvention: env var name
		expect(() => createConfig({ PORT: "abc" })).toThrow();
	});
});
