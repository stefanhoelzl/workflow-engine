import { z } from "@workflow-engine/sdk";

const schema = z
	.object({
		// biome-ignore lint/style/useNamingConvention: env var name
		LOG_LEVEL: z
			.enum(["fatal", "error", "warn", "info", "debug", "trace"])
			.default("info"),
		// biome-ignore lint/style/useNamingConvention: env var name
		// biome-ignore lint/style/noMagicNumbers: default port
		PORT: z.coerce.number().default(8080),
		// biome-ignore lint/style/useNamingConvention: env var name
		FILE_IO_CONCURRENCY: z.coerce.number().default(10),
	})
	.transform((env) => ({
		logLevel: env.LOG_LEVEL,
		port: env.PORT,
		fileIoConcurrency: env.FILE_IO_CONCURRENCY,
	}));

export function createConfig(env: Record<string, string | undefined>) {
	return schema.parse(env);
}
