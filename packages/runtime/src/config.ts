import { z } from "zod";

const schema = z
	.object({
		// biome-ignore lint/style/useNamingConvention: env var name
		LOG_LEVEL: z
			.enum(["fatal", "error", "warn", "info", "debug", "trace"])
			.default("info"),
		// biome-ignore lint/style/useNamingConvention: env var name
		// biome-ignore lint/style/noMagicNumbers: default port
		PORT: z.coerce.number().default(8080),
	})
	.transform((env) => ({
		logLevel: env.LOG_LEVEL,
		port: env.PORT,
	}));

export function createConfig(env: Record<string, string | undefined>) {
	return schema.parse(env);
}
