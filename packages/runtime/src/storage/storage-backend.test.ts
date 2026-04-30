import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { createSecret } from "../config.js";
import { createFsStorage } from "./fs.js";
import type { StorageBackend } from "./index.js";
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

		it("write and read roundtrip arbitrary binary data", async () => {
			const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
			await backend.write("dir/bundle.tar.gz", payload);
			const data = await backend.read("dir/bundle.tar.gz");
			expect(Array.from(data)).toEqual(Array.from(payload));
		});

		it("write overwrites existing key", async () => {
			await backend.write("dir/bundle.tar.gz", new Uint8Array([1, 2, 3]));
			await backend.write("dir/bundle.tar.gz", new Uint8Array([9, 8]));
			const data = await backend.read("dir/bundle.tar.gz");
			expect(Array.from(data)).toEqual([9, 8]);
		});

		it("list yields matching paths", async () => {
			await backend.write("workflows/a.tar.gz", new Uint8Array([1]));
			await backend.write("workflows/b.tar.gz", new Uint8Array([2]));
			await backend.write("events.duckdb", new Uint8Array([3]));

			const results: string[] = [];
			for await (const path of backend.list("workflows/")) {
				results.push(path);
			}

			expect(results).toContain("workflows/a.tar.gz");
			expect(results).toContain("workflows/b.tar.gz");
			expect(results).not.toContain("events.duckdb");
		});

		it("list yields sorted paths", async () => {
			await backend.write("workflows/c.tar.gz", new Uint8Array([1]));
			await backend.write("workflows/a.tar.gz", new Uint8Array([2]));
			await backend.write("workflows/b.tar.gz", new Uint8Array([3]));

			const results: string[] = [];
			for await (const path of backend.list("workflows/")) {
				results.push(path);
			}

			expect(results).toEqual([
				"workflows/a.tar.gz",
				"workflows/b.tar.gz",
				"workflows/c.tar.gz",
			]);
		});

		it("list returns nothing for empty prefix", async () => {
			const results: string[] = [];
			for await (const path of backend.list("workflows/")) {
				results.push(path);
			}
			expect(results).toEqual([]);
		});

		it("list yields paths recursively", async () => {
			await backend.write("workflows/foo/bar.tar.gz", new Uint8Array([1]));
			await backend.write("workflows/foo/baz.tar.gz", new Uint8Array([2]));
			await backend.write("events.duckdb", new Uint8Array([3]));

			const results: string[] = [];
			for await (const path of backend.list("workflows/")) {
				results.push(path);
			}

			expect(results).toContain("workflows/foo/bar.tar.gz");
			expect(results).toContain("workflows/foo/baz.tar.gz");
			expect(results).not.toContain("events.duckdb");
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

// Run against S3 backend (s3rver) — each test uses a fresh per-test bucket dir
let s3Server: { close(): Promise<void> } | undefined;
let s3Port = 0;
const s3Dir = join(tmpdir(), `s3rver-${crypto.randomUUID()}`);

const require = createRequire(import.meta.url);
const createS3rver = require("s3rver") as new (opts: {
	port: number;
	directory: string;
	silent: boolean;
	configureBuckets: { name: string }[];
}) => { run(): Promise<{ port: number }>; close(): Promise<void> };

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
	const bucketDir = join(s3Dir, "test-bucket");
	return {
		backend: createS3Storage({
			bucket: "test-bucket",
			accessKeyId: createSecret("S3RVER"),
			secretAccessKey: createSecret("S3RVER"),
			endpoint: `http://localhost:${s3Port}`,
			region: "us-east-1",
		}),
		// Wipe the s3rver-managed bucket directory directly. Avoids reintroducing a
		// `remove` method on the StorageBackend interface just for test cleanup.
		cleanup: async () => {
			await rm(bucketDir, { recursive: true, force: true });
			await mkdir(bucketDir, { recursive: true });
		},
	};
});

describe("StorageBackend.locator", () => {
	it("fs backend returns absolute root", async () => {
		const dir = join(tmpdir(), `locator-fs-${crypto.randomUUID()}`);
		await mkdir(dir, { recursive: true });
		try {
			const backend = createFsStorage(dir);
			const locator = backend.locator();
			expect(locator.kind).toBe("fs");
			if (locator.kind === "fs") {
				expect(locator.root).toBe(dir);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("s3 backend returns bucket and Secret-wrapped credentials", () => {
		const accessKeyId = createSecret("ak");
		const secretAccessKey = createSecret("sk");
		const backend = createS3Storage({
			bucket: "wfe",
			accessKeyId,
			secretAccessKey,
			endpoint: "http://s2.local:9000",
			region: "auto",
		});
		const locator = backend.locator();
		expect(locator.kind).toBe("s3");
		if (locator.kind === "s3") {
			expect(locator.bucket).toBe("wfe");
			expect(locator.endpoint).toBe("http://s2.local:9000");
			expect(locator.region).toBe("auto");
			expect(locator.urlStyle).toBe("path");
			expect(locator.useSsl).toBe(false);
			expect(locator.accessKeyId.reveal()).toBe("ak");
			expect(locator.secretAccessKey.reveal()).toBe("sk");
		}
	});

	it("s3 backend defaults to virtual urlStyle and AWS endpoint when no endpoint is set", () => {
		const backend = createS3Storage({
			bucket: "wfe",
			accessKeyId: createSecret("ak"),
			secretAccessKey: createSecret("sk"),
			region: "eu-fra-1",
		});
		const locator = backend.locator();
		expect(locator.kind).toBe("s3");
		if (locator.kind === "s3") {
			expect(locator.urlStyle).toBe("virtual");
			expect(locator.endpoint).toBe("s3.eu-fra-1.amazonaws.com");
			expect(locator.useSsl).toBe(true);
		}
	});
});
