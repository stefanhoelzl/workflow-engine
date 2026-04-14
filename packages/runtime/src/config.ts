import { z } from "@workflow-engine/sdk";

const DISABLE_AUTH_SENTINEL = "__DISABLE_AUTH__";
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

type GitHubAuth =
	| { mode: "disabled" }
	| { mode: "open" }
	| { mode: "restricted"; users: string[] };

function parseGitHubAuth(raw: string | undefined): GitHubAuth {
	if (raw === undefined) {
		return { mode: "disabled" };
	}
	if (raw === DISABLE_AUTH_SENTINEL) {
		return { mode: "open" };
	}
	return { mode: "restricted", users: raw.split(",") };
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
		GITHUB_USER: z.string().optional(),
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
	.refine(
		(env) => {
			const raw = env.GITHUB_USER;
			if (raw === undefined || raw === DISABLE_AUTH_SENTINEL) {
				return true;
			}
			return !raw.split(",").includes(DISABLE_AUTH_SENTINEL);
		},
		{
			message: `GITHUB_USER sentinel "${DISABLE_AUTH_SENTINEL}" must be the only value`,
			path: ["GITHUB_USER"],
		},
	)
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
		githubAuth: parseGitHubAuth(env.GITHUB_USER),
		persistencePath: env.PERSISTENCE_PATH,
		persistenceS3Bucket: env.PERSISTENCE_S3_BUCKET,
		persistenceS3AccessKeyId: env.PERSISTENCE_S3_ACCESS_KEY_ID,
		persistenceS3SecretAccessKey: env.PERSISTENCE_S3_SECRET_ACCESS_KEY,
		persistenceS3Endpoint: env.PERSISTENCE_S3_ENDPOINT,
		persistenceS3Region: env.PERSISTENCE_S3_REGION,
		baseUrl: env.BASE_URL,
	}));

export type { GitHubAuth, Secret };
export { createSecret, DISABLE_AUTH_SENTINEL };

export function createConfig(env: Record<string, string | undefined>) {
	return schema.parse(env);
}
