import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collect, conformanceSuite } from "./conformance-suite.js";
import { createFsStorage } from "./fs.js";

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
