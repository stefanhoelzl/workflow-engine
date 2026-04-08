import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StorageBackend } from "./index.js";

function createFsStorage(root: string): StorageBackend {
	return {
		async init() {
			await mkdir(root, { recursive: true });
		},

		async write(path, data) {
			const fullPath = join(root, path);
			const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
			await mkdir(dir, { recursive: true });
			const tmp = `${fullPath}.tmp`;
			await writeFile(tmp, data, "utf-8");
			await rename(tmp, fullPath);
		},

		async read(path) {
			return await readFile(join(root, path), "utf-8");
		},

		async *list(prefix) {
			const dir = join(root, prefix);
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch {
				return;
			}
			entries.sort();
			for (const entry of entries) {
				yield `${prefix}${entry}`;
			}
		},

		async remove(path) {
			await unlink(join(root, path));
		},

		async move(from, to) {
			const toFull = join(root, to);
			const toDir = toFull.slice(0, toFull.lastIndexOf("/"));
			await mkdir(toDir, { recursive: true });
			await rename(join(root, from), toFull);
		},
	};
}

export { createFsStorage };
