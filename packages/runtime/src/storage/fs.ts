import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StorageBackend, StorageLocator } from "./index.js";

function createFsStorage(root: string): StorageBackend {
	const absoluteRoot = resolve(root);
	return {
		async init() {
			await mkdir(absoluteRoot, { recursive: true });
		},

		async write(path, data) {
			const fullPath = join(absoluteRoot, path);
			const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
			await mkdir(dir, { recursive: true });
			const tmp = `${fullPath}.tmp`;
			await writeFile(tmp, data);
			await rename(tmp, fullPath);
		},

		async read(path) {
			const buf = await readFile(join(absoluteRoot, path));
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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

		locator(): StorageLocator {
			return { kind: "fs", root: absoluteRoot };
		},
	};
}

export { createFsStorage };
