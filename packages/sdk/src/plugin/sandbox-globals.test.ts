import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// sandbox-globals.js uses the pattern:
//   import { X, Y } from "some-polyfill";
//   globalThis.X = X; globalThis.Y = Y;
// A missing assignment (the `btoa` bug) leaves the global undefined inside
// the sandbox. This test scans the source and asserts every *named* import
// either has a matching `globalThis.<name> = <name>` line or is an
// explicitly-listed runtime-only helper.

const srcDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(srcDir, "sandbox-globals.js"), "utf8");

// Names imported for internal use in sandbox-globals.js itself, not for
// exposure to user code. Keep this list tight.
const internalOnly = new Set(["newMockXhr"]);

const IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g;
const AS_RE = /\s+as\s+/;

function collectNamedImports(src: string): string[] {
	const names: string[] = [];
	for (const match of src.matchAll(IMPORT_RE)) {
		const group = match[1];
		if (!group) {
			continue;
		}
		for (const raw of group.split(",")) {
			const before = raw.trim().split(AS_RE)[0];
			if (!before) {
				continue;
			}
			const name = before.trim();
			if (name) {
				names.push(name);
			}
		}
	}
	return names;
}

describe("sandbox-globals.js contract", () => {
	it("every named import is exposed on globalThis", () => {
		const imported = collectNamedImports(source);
		const missing = imported
			.filter((n) => !internalOnly.has(n))
			.filter((n) => !new RegExp(`globalThis\\.${n}\\s*=`).test(source));
		expect(missing).toEqual([]);
	});
});
