import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NotFoundError, type StorageBackend } from "./index.js";

async function createFsStorage(root: string): Promise<StorageBackend> {
	const absoluteRoot = resolve(root);
	await mkdir(absoluteRoot, { recursive: true });
	return {
		async write(path, data) {
			const fullPath = join(absoluteRoot, path);
			const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
			await mkdir(dir, { recursive: true });
			const tmp = `${fullPath}.tmp`;
			await writeFile(tmp, data);
			await rename(tmp, fullPath);
		},

		async read(path) {
			try {
				const buf = await readFile(join(absoluteRoot, path));
				return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					throw new NotFoundError(path);
				}
				throw err;
			}
		},

		async *list(prefix) {
			const dir = join(absoluteRoot, prefix);
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(dir, { recursive: true, withFileTypes: true });
			} catch {
				return;
			}
			const paths = entries
				// `.tmp` files are write-staging artifacts from an interrupted
				// `write` (writeFile then rename); they are never committed keys.
				.filter((e) => e.isFile() && !e.name.endsWith(".tmp"))
				.map((e) => {
					const relative = e.parentPath.slice(dir.length);
					return relative ? `${relative}/${e.name}` : e.name;
				})
				.sort();
			for (const entry of paths) {
				yield `${prefix}${entry}`;
			}
		},
	};
}

export { createFsStorage };
