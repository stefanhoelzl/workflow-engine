import { z } from "@workflow-engine/core";

const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

interface Secret {
	reveal(): string;
	// biome-ignore lint/style/useNamingConvention: JSON.stringify serialization hook
	toJSON(): string;
	toString(): string;
}

function createSecret(value: string): Secret {
	const redact = () => "[redacted]";
	const secret = {
		reveal: () => value,
		// biome-ignore lint/style/useNamingConvention: JSON.stringify serialization hook
		toJSON: redact,
		toString: redact,
		[INSPECT_CUSTOM]: redact,
	};
	return secret;
}

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
		AUTH_ALLOW: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		GITHUB_OAUTH_CLIENT_ID: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		GITHUB_OAUTH_CLIENT_SECRET: z.exactOptional(
			z.string().transform(createSecret),
		),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_PATH: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_BUCKET: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_ACCESS_KEY_ID: z.exactOptional(
			z.string().transform(createSecret),
		),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_SECRET_ACCESS_KEY: z.exactOptional(
			z.string().transform(createSecret),
		),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_ENDPOINT: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_REGION: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		BASE_URL: z.exactOptional(z.string()),
		// biome-ignore lint/style/useNamingConvention: env var name
		LOCAL_DEPLOYMENT: z.exactOptional(z.string()),
		// CSV of `keyId:base64(sk)` entries; primary (active sealing) key first.
		// See packages/runtime/src/secrets/parse-keys.ts for the grammar.
		// biome-ignore lint/style/useNamingConvention: env var name
		SECRETS_PRIVATE_KEYS: z.string().transform(createSecret),
	})
	.refine((env) => !(env.PERSISTENCE_PATH && env.PERSISTENCE_S3_BUCKET), {
		message:
			"PERSISTENCE_PATH and PERSISTENCE_S3_BUCKET are mutually exclusive",
	})
	.refine(
		(env) =>
			env.PERSISTENCE_S3_BUCKET === undefined ||
			(env.PERSISTENCE_S3_ACCESS_KEY_ID !== undefined &&
				env.PERSISTENCE_S3_SECRET_ACCESS_KEY !== undefined),
		{
			message:
				"PERSISTENCE_S3_BUCKET requires PERSISTENCE_S3_ACCESS_KEY_ID and PERSISTENCE_S3_SECRET_ACCESS_KEY",
		},
	)
	.transform((env) => ({
		logLevel: env.LOG_LEVEL,
		port: env.PORT,
		fileIoConcurrency: env.FILE_IO_CONCURRENCY,
		authAllow: env.AUTH_ALLOW,
		githubOauthClientId: env.GITHUB_OAUTH_CLIENT_ID,
		githubOauthClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
		persistencePath: env.PERSISTENCE_PATH,
		persistenceS3Bucket: env.PERSISTENCE_S3_BUCKET,
		persistenceS3AccessKeyId: env.PERSISTENCE_S3_ACCESS_KEY_ID,
		persistenceS3SecretAccessKey: env.PERSISTENCE_S3_SECRET_ACCESS_KEY,
		persistenceS3Endpoint: env.PERSISTENCE_S3_ENDPOINT,
		persistenceS3Region: env.PERSISTENCE_S3_REGION,
		baseUrl: env.BASE_URL,
		localDeployment: env.LOCAL_DEPLOYMENT,
		secretsPrivateKeys: env.SECRETS_PRIVATE_KEYS,
	}));

export type { Secret };
export { createSecret };

export function createConfig(env: Record<string, string | undefined>) {
	return schema.parse(env);
}
