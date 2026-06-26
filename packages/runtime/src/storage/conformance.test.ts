import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createFsStorage } from "./fs.js";
import { NotFoundError, type StorageBackend } from "./index.js";

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const path of stream) {
		out.push(path);
	}
	return out;
}

// Backend-agnostic contract every StorageBackend implementation must satisfy.
// A future S3/Bunny backend re-runs this by calling `conformanceSuite` with its
// own factory — no new assertions needed, the contract is the same.
function conformanceSuite(
	label: string,
	makeBackend: () => Promise<StorageBackend>,
): void {
	describe(`StorageBackend conformance: ${label}`, () => {
		let backend: StorageBackend;

		beforeEach(async () => {
			backend = await makeBackend();
		});

		it("roundtrips arbitrary binary bytes", async () => {
			const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
			await backend.write("workflows/foo/bar.tar.gz", payload);
			const data = await backend.read("workflows/foo/bar.tar.gz");
			expect(Array.from(data)).toEqual(Array.from(payload));
		});

		it("atomically replaces an existing key on overwrite", async () => {
			await backend.write("workflows/a.tar.gz", new Uint8Array([1, 2, 3]));
			await backend.write("workflows/a.tar.gz", new Uint8Array([9, 8]));
			const data = await backend.read("workflows/a.tar.gz");
			expect(Array.from(data)).toEqual([9, 8]);
		});

		it("lists committed keys under a prefix recursively, excluding non-matches", async () => {
			await backend.write("workflows/foo/bar.tar.gz", new Uint8Array([1]));
			await backend.write("workflows/baz.tar.gz", new Uint8Array([2]));
			await backend.write("events.db", new Uint8Array([3]));

			const results = await collect(backend.list("workflows/"));

			expect(results).toContain("workflows/foo/bar.tar.gz");
			expect(results).toContain("workflows/baz.tar.gz");
			expect(results).not.toContain("events.db");
		});

		it("lists nothing under a prefix with no committed keys", async () => {
			const results = await collect(backend.list("workflows/"));
			expect(results).toEqual([]);
		});

		it("throws NotFoundError when reading a missing key", async () => {
			await expect(
				backend.read("workflows/none.tar.gz"),
			).rejects.toBeInstanceOf(NotFoundError);
		});
	});
}

const fsDirs: string[] = [];

afterAll(async () => {
	await Promise.all(
		fsDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

conformanceSuite("fs", async () => {
	const dir = join(tmpdir(), `storage-conformance-${crypto.randomUUID()}`);
	fsDirs.push(dir);
	return await createFsStorage(dir);
});

// fs-specific crash case: a `write` that died after writeFile(<tmp>) but before
// rename leaves a `<key>.tmp` artifact on disk. `list` must never surface it as
// a committed key (object stores have no such artifact, so this is fs-only).
describe("StorageBackend fs: crash artifacts", () => {
	it("excludes leftover *.tmp write-staging files from list", async () => {
		const dir = join(tmpdir(), `storage-tmp-${crypto.randomUUID()}`);
		fsDirs.push(dir);
		const backend = await createFsStorage(dir);
		await mkdir(join(dir, "workflows", "foo"), { recursive: true });
		await writeFile(
			join(dir, "workflows", "foo", "bar.tar.gz.tmp"),
			new Uint8Array([1]),
		);

		const results = await collect(backend.list("workflows/"));

		expect(results.every((path) => !path.endsWith(".tmp"))).toBe(true);
	});
});
