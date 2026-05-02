import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStorage } from "./fs.js";
import type { StorageBackend } from "./index.js";

describe("StorageBackend: fs", () => {
	let backend: StorageBackend;
	let dir: string;

	beforeEach(async () => {
		dir = join(tmpdir(), `storage-test-${crypto.randomUUID()}`);
		await mkdir(dir, { recursive: true });
		backend = createFsStorage(dir);
		await backend.init();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
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
