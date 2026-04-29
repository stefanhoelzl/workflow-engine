import { createHash } from "node:crypto";
import {
	CopyObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import type { StorageBackend } from "./index.js";

// UpCloud Object Storage requires legacy `Content-MD5` on `DeleteObjects` and
// rejects the AWS-SDK-v3 flexible-checksum headers (`x-amz-sdk-checksum-*`,
// `x-amz-checksum-*`). The SDK does not expose `ChecksumAlgorithm: "MD5"` on
// the DeleteObjects command input, so we inject Content-MD5 ourselves at the
// `build` step (after serialization, before signing — so MD5 ends up in the
// signed canonical request) and strip the flexible-checksum headers the SDK
// added in an earlier build-step middleware.
function injectDeleteObjectsContentMd5(client: S3Client): void {
	client.middlewareStack.add(
		(next, context) => (args) => {
			if (context.commandName !== "DeleteObjectsCommand") {
				return next(args);
			}
			const request = args.request as {
				body?: string | Uint8Array;
				headers: Record<string, string>;
			};
			const body = request.body ?? "";
			const buf =
				typeof body === "string"
					? Buffer.from(body, "utf-8")
					: Buffer.from(body);
			for (const key of Object.keys(request.headers)) {
				const lower = key.toLowerCase();
				if (
					lower === "x-amz-sdk-checksum-algorithm" ||
					lower.startsWith("x-amz-checksum-")
				) {
					delete request.headers[key];
				}
			}
			request.headers["content-md5"] = createHash("md5")
				.update(buf)
				.digest("base64");
			return next(args);
		},
		{
			step: "build",
			name: "upcloudDeleteObjectsContentMd5",
			priority: "low",
		},
	);
}

interface S3StorageOptions {
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	endpoint?: string;
	region?: string;
	logger?: {
		error(msg: string, data: Record<string, unknown>): void;
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups all S3 operations
function createS3Storage(options: S3StorageOptions): StorageBackend {
	const { bucket } = options;
	const logger = options.logger;
	const client = new S3Client({
		credentials: {
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
		},
		region: options.region ?? "us-east-1",
		// Pre-flagday integrity behaviour: only attach a checksum when the op
		// requires one (DeleteObjects → Content-MD5). The post-flagday default
		// (`WHEN_SUPPORTED` + CRC32 via `x-amz-sdk-checksum-algorithm`) is
		// rejected by UpCloud Object Storage's S3 surface.
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
		...(options.endpoint
			? { endpoint: options.endpoint, forcePathStyle: true }
			: {}),
	});
	injectDeleteObjectsContentMd5(client);

	return {
		async init() {
			await client.send(new HeadBucketCommand({ Bucket: bucket }));
		},

		async write(path, data) {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: path,
					Body: data,
					ContentType: "application/json",
				}),
			);
		},

		async writeBytes(path, data) {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: path,
					Body: data,
					ContentType: "application/octet-stream",
				}),
			);
		},

		async read(path) {
			const response = await client.send(
				new GetObjectCommand({ Bucket: bucket, Key: path }),
			);
			return (await response.Body?.transformToString("utf-8")) ?? "";
		},

		async readBytes(path) {
			const response = await client.send(
				new GetObjectCommand({ Bucket: bucket, Key: path }),
			);
			const bytes = await response.Body?.transformToByteArray();
			return bytes ?? new Uint8Array(0);
		},

		async *list(prefix) {
			let continuationToken: string | undefined;
			do {
				// biome-ignore lint/performance/noAwaitInLoops: sequential pagination required by S3 API
				const response = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						ContinuationToken: continuationToken,
					}),
				);
				if (response.Contents) {
					const keys = response.Contents.map((obj) => obj.Key)
						.filter((key): key is string => key != null)
						.sort();
					for (const key of keys) {
						yield key;
					}
				}
				continuationToken = response.NextContinuationToken;
			} while (continuationToken);
		},

		async remove(path) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
		},

		async removePrefix(prefix) {
			let continuationToken: string | undefined;
			do {
				// biome-ignore lint/performance/noAwaitInLoops: sequential pagination required by S3 API
				const listed = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						ContinuationToken: continuationToken,
					}),
				);
				const keys = (listed.Contents ?? [])
					.map((obj) => obj.Key)
					.filter((key): key is string => key != null);
				if (keys.length > 0) {
					const deleted = await client.send(
						new DeleteObjectsCommand({
							Bucket: bucket,
							Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
						}),
					);
					if (deleted.Errors && deleted.Errors.length > 0) {
						logger?.error("storage.s3.remove-prefix-failed", {
							prefix,
							errors: deleted.Errors.map((e) => ({
								key: e.Key,
								code: e.Code,
								message: e.Message,
							})),
						});
					}
				}
				continuationToken = listed.NextContinuationToken;
			} while (continuationToken);
		},

		async move(from, to) {
			await client.send(
				new CopyObjectCommand({
					Bucket: bucket,
					CopySource: `${bucket}/${from}`,
					Key: to,
				}),
			);
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
		},
	};
}

export type { S3StorageOptions };
export { createS3Storage };
