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
		// biome-ignore lint/style/useNamingConvention: env var name
		WORKFLOW_DIR: z.string(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_PATH: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_BUCKET: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_ACCESS_KEY_ID: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_SECRET_ACCESS_KEY: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_ENDPOINT: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_REGION: z.string().optional(),
	})
	.refine(
		(env) => !(env.PERSISTENCE_PATH && env.PERSISTENCE_S3_BUCKET),
		{ message: "PERSISTENCE_PATH and PERSISTENCE_S3_BUCKET are mutually exclusive" },
	)
	.refine(
		(env) => !env.PERSISTENCE_S3_BUCKET || (env.PERSISTENCE_S3_ACCESS_KEY_ID && env.PERSISTENCE_S3_SECRET_ACCESS_KEY),
		{ message: "PERSISTENCE_S3_BUCKET requires PERSISTENCE_S3_ACCESS_KEY_ID and PERSISTENCE_S3_SECRET_ACCESS_KEY" },
	)
	.transform((env) => ({
		logLevel: env.LOG_LEVEL,
		port: env.PORT,
		fileIoConcurrency: env.FILE_IO_CONCURRENCY,
		workflowDir: env.WORKFLOW_DIR,
		persistencePath: env.PERSISTENCE_PATH,
		persistenceS3Bucket: env.PERSISTENCE_S3_BUCKET,
		persistenceS3AccessKeyId: env.PERSISTENCE_S3_ACCESS_KEY_ID,
		persistenceS3SecretAccessKey: env.PERSISTENCE_S3_SECRET_ACCESS_KEY,
		persistenceS3Endpoint: env.PERSISTENCE_S3_ENDPOINT,
		persistenceS3Region: env.PERSISTENCE_S3_REGION,
	}));

export function createConfig(env: Record<string, string | undefined>) {
	return schema.parse(env);
}
