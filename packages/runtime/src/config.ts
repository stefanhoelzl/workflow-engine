import { z } from "@workflow-engine/core";
import { type Auth, parseAuth } from "./auth/allowlist.js";

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
		AUTH_ALLOW: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		GITHUB_OAUTH_CLIENT_SECRET: z.string().transform(createSecret).optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_PATH: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_BUCKET: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_ACCESS_KEY_ID: z.string().transform(createSecret).optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_SECRET_ACCESS_KEY: z
			.string()
			.transform(createSecret)
			.optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_ENDPOINT: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		PERSISTENCE_S3_REGION: z.string().optional(),
		// biome-ignore lint/style/useNamingConvention: env var name
		BASE_URL: z.string().optional(),
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
	.transform((env, ctx) => {
		let auth: Auth;
		try {
			auth = parseAuth(env.AUTH_ALLOW);
		} catch (err) {
			ctx.addIssue({
				code: "custom",
				message: err instanceof Error ? err.message : "AUTH_ALLOW is malformed",
				path: ["AUTH_ALLOW"],
			});
			return z.NEVER;
		}
		if (auth.mode === "restricted") {
			const missing: string[] = [];
			if (env.GITHUB_OAUTH_CLIENT_ID === undefined) {
				missing.push("GITHUB_OAUTH_CLIENT_ID");
			}
			if (env.GITHUB_OAUTH_CLIENT_SECRET === undefined) {
				missing.push("GITHUB_OAUTH_CLIENT_SECRET");
			}
			if (env.BASE_URL === undefined) {
				missing.push("BASE_URL");
			}
			if (missing.length > 0) {
				ctx.addIssue({
					code: "custom",
					message: `${missing.join(", ")} required when AUTH_ALLOW configures a restricted allow-list`,
				});
				return z.NEVER;
			}
		}
		return {
			logLevel: env.LOG_LEVEL,
			port: env.PORT,
			fileIoConcurrency: env.FILE_IO_CONCURRENCY,
			auth,
			githubOauthClientId: env.GITHUB_OAUTH_CLIENT_ID,
			githubOauthClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
			persistencePath: env.PERSISTENCE_PATH,
			persistenceS3Bucket: env.PERSISTENCE_S3_BUCKET,
			persistenceS3AccessKeyId: env.PERSISTENCE_S3_ACCESS_KEY_ID,
			persistenceS3SecretAccessKey: env.PERSISTENCE_S3_SECRET_ACCESS_KEY,
			persistenceS3Endpoint: env.PERSISTENCE_S3_ENDPOINT,
			persistenceS3Region: env.PERSISTENCE_S3_REGION,
			baseUrl: env.BASE_URL,
		};
	});

export type { Secret };
export { createSecret };

export function createConfig(env: Record<string, string | undefined>) {
	return schema.parse(env);
}
