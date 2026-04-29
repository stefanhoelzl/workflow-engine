import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createS3Storage } from "./s3.js";

describe("S3 DeleteObjects header shape (UpCloud compat)", () => {
	it("sends Content-MD5 and no x-amz-(sdk-)?checksum-* on DeleteObjects", async () => {
		const captured: { method: string; headers: Record<string, string> }[] = [];
		const server = createServer((req, res) => {
			req.on("data", () => {});
			req.on("end", () => {
				captured.push({
					method: req.method ?? "",
					headers: req.headers as Record<string, string>,
				});
				if (req.method === "POST" && (req.url ?? "").includes("delete")) {
					res.setHeader("Content-Type", "application/xml");
					res.end(
						'<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
					);
					return;
				}
				if (req.method === "GET") {
					res.setHeader("Content-Type", "application/xml");
					res.end(
						'<?xml version="1.0" encoding="UTF-8"?>' +
							'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
							"<Name>test-bucket</Name><Prefix>pending/x/</Prefix>" +
							"<KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>" +
							"<Contents><Key>pending/x/a.json</Key></Contents>" +
							"</ListBucketResult>",
					);
					return;
				}
				res.statusCode = 200;
				res.end();
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const port = (server.address() as AddressInfo).port;

		try {
			const backend = createS3Storage({
				bucket: "test-bucket",
				accessKeyId: "AKIA",
				secretAccessKey: "secret",
				endpoint: `http://127.0.0.1:${port}`,
				region: "us-east-1",
			});
			await backend.removePrefix("pending/x/");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		const deleteCall = captured.find(
			(c) => c.method === "POST" && c.headers["content-md5"] !== undefined,
		);
		expect(deleteCall, "DeleteObjects POST not observed").toBeDefined();
		const headers = (deleteCall as (typeof captured)[number]).headers;
		expect(headers["content-md5"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
		for (const name of Object.keys(headers)) {
			expect(name).not.toMatch(/^x-amz-sdk-checksum-algorithm$/i);
			expect(name).not.toMatch(/^x-amz-checksum-/i);
		}
	});
});
