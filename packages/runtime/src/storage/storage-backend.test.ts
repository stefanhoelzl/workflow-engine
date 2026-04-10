import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import type { StorageBackend } from "./index.js";
import { createFsStorage } from "./fs.js";
import { createS3Storage } from "./s3.js";

function storageBackendTests(
	name: string,
	setup: () => Promise<{
		backend: StorageBackend;
		cleanup: () => Promise<void>;
	}>,
) {
	describe(`StorageBackend: ${name}`, () => {
		let backend: StorageBackend;
		let cleanup: () => Promise<void>;

		beforeEach(async () => {
			const ctx = await setup();
			backend = ctx.backend;
			cleanup = ctx.cleanup;
			await backend.init();
		});

		afterEach(async () => {
			await cleanup();
		});

		it("write and read roundtrip", async () => {
			await backend.write("dir/file.json", '{"id":"evt_1"}');
			const data = await backend.read("dir/file.json");
			expect(data).toBe('{"id":"evt_1"}');
		});

		it("list yields matching paths", async () => {
			await backend.write("pending/a.json", "a");
			await backend.write("pending/b.json", "b");
			await backend.write("archive/c.json", "c");

			const results: string[] = [];
			for await (const path of backend.list("pending/")) {
				results.push(path);
			}

			expect(results).toContain("pending/a.json");
			expect(results).toContain("pending/b.json");
			expect(results).not.toContain("archive/c.json");
		});

		it("list yields sorted paths", async () => {
			await backend.write("pending/c.json", "c");
			await backend.write("pending/a.json", "a");
			await backend.write("pending/b.json", "b");

			const results: string[] = [];
			for await (const path of backend.list("pending/")) {
				results.push(path);
			}

			expect(results).toEqual([
				"pending/a.json",
				"pending/b.json",
				"pending/c.json",
			]);
		});

		it("list returns nothing for empty prefix", async () => {
			const results: string[] = [];
			for await (const path of backend.list("pending/")) {
				results.push(path);
			}
			expect(results).toEqual([]);
		});

		it("move relocates a file", async () => {
			await backend.write("pending/a.json", "content");
			await backend.move("pending/a.json", "archive/a.json");

			const data = await backend.read("archive/a.json");
			expect(data).toBe("content");

			const pending: string[] = [];
			for await (const path of backend.list("pending/")) {
				pending.push(path);
			}
			expect(pending).not.toContain("pending/a.json");
		});

		it("remove deletes a file", async () => {
			await backend.write("pending/a.json", "content");
			await backend.remove("pending/a.json");

			const results: string[] = [];
			for await (const path of backend.list("pending/")) {
				results.push(path);
			}
			expect(results).not.toContain("pending/a.json");
		});

		it("list yields paths recursively", async () => {
			await backend.write("workflows/foo/manifest.json", "{}");
			await backend.write("workflows/foo/actions/handle.js", "code");
			await backend.write("events/pending/001.json", "evt");

			const results: string[] = [];
			for await (const path of backend.list("workflows/")) {
				results.push(path);
			}

			expect(results).toContain("workflows/foo/manifest.json");
			expect(results).toContain("workflows/foo/actions/handle.js");
			expect(results).not.toContain("events/pending/001.json");
		});

		it("write overwrites existing file", async () => {
			await backend.write("pending/a.json", "old");
			await backend.write("pending/a.json", "new");
			const data = await backend.read("pending/a.json");
			expect(data).toBe("new");
		});
	});
}

// Run against FS backend
storageBackendTests("fs", async () => {
	const dir = join(tmpdir(), `storage-test-${crypto.randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return {
		backend: createFsStorage(dir),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
});

// Run against S3 backend (s3rver)
let s3Server: { close(): Promise<void> } | undefined;
let s3Port = 0;

const require = createRequire(import.meta.url);
const createS3rver = require("s3rver") as new (opts: {
	port: number;
	directory: string;
	silent: boolean;
	configureBuckets: { name: string }[];
}) => { run(): Promise<{ port: number }>; close(): Promise<void> };

const s3Dir = join(tmpdir(), `s3rver-${crypto.randomUUID()}`);

beforeAll(async () => {
	await mkdir(s3Dir, { recursive: true });
	const server = new createS3rver({
		port: 0,
		directory: s3Dir,
		silent: true,
		configureBuckets: [{ name: "test-bucket" }],
	});
	const info = await server.run();
	s3Port = info.port;
	s3Server = server;
});

afterAll(async () => {
	await s3Server?.close();
	await rm(s3Dir, { recursive: true, force: true });
});

storageBackendTests("s3", async () => {
	const s3Cleanup = createS3Storage({
		bucket: "test-bucket",
		accessKeyId: "S3RVER",
		secretAccessKey: "S3RVER",
		endpoint: `http://localhost:${s3Port}`,
		region: "us-east-1",
	});

	return {
		backend: createS3Storage({
			bucket: "test-bucket",
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${s3Port}`,
			region: "us-east-1",
		}),
		cleanup: async () => {
			const keys: string[] = [];
			for await (const key of s3Cleanup.list("")) {
				keys.push(key);
			}
			for (const key of keys) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
				await s3Cleanup.remove(key);
			}
		},
	};
});

export { storageBackendTests };
