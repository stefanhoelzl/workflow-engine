import {
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import type { Secret } from "../config.js";
import type { StorageBackend, StorageLocator } from "./index.js";

interface S3StorageOptions {
	bucket: string;
	accessKeyId: Secret;
	secretAccessKey: Secret;
	endpoint?: string;
	region?: string;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups all S3 operations against a single client + the locator() projection over the configured options
function createS3Storage(options: S3StorageOptions): StorageBackend {
	const { bucket } = options;
	const region = options.region ?? "us-east-1";
	const endpoint = options.endpoint;
	const useSsl = endpoint ? !endpoint.startsWith("http://") : true;
	const client = new S3Client({
		credentials: {
			accessKeyId: options.accessKeyId.reveal(),
			secretAccessKey: options.secretAccessKey.reveal(),
		},
		region,
		// Pre-flagday integrity behaviour: only attach a checksum when the op
		// requires one. The post-flagday default is rejected by UpCloud Object
		// Storage's S3 surface.
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
		...(endpoint ? { endpoint, forcePathStyle: true } : {}),
	});

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
					ContentType: "application/octet-stream",
				}),
			);
		},

		async read(path) {
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

		locator(): StorageLocator {
			return {
				kind: "s3",
				bucket,
				endpoint: endpoint ?? `s3.${region}.amazonaws.com`,
				region,
				accessKeyId: options.accessKeyId,
				secretAccessKey: options.secretAccessKey,
				urlStyle: endpoint ? "path" : "virtual",
				useSsl,
			};
		},
	};
}

export type { S3StorageOptions };
export { createS3Storage };
