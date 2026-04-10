import {
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
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
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(dir, { recursive: true, withFileTypes: true });
			} catch {
				return;
			}
			const paths = entries
				.filter((e) => e.isFile())
				.map((e) => {
					const relative = e.parentPath.slice(dir.length);
					return relative ? `${relative}/${e.name}` : e.name;
				})
				.sort();
			for (const entry of paths) {
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
