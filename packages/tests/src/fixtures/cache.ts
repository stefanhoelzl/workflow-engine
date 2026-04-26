import { createHash } from "node:crypto";
import {
	access,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
// Cache lives under packages/tests so the per-fixture project inherits the
// nearest tsconfig.json (packages/tests/tsconfig.json) for `typecheckWorkflows`
// and resolves `@workflow-engine/sdk` through packages/tests/node_modules.
// Anchoring under repo-root node_modules placed fixtures outside any tsconfig
// scope and broke typecheck.
const TESTS_PKG = resolve(import.meta.dirname, "..", "..");
const CACHE_DIR = join(TESTS_PKG, ".cache", "wfe-tests");
const SENTINEL_FILE = join(CACHE_DIR, ".build-hash");

// Tracks which dist trees the cache is keyed against. A change to file
// path / mtimeMs / size in any of these invalidates the entire cache.
// The runtime build (`packages/runtime/dist`) is intentionally excluded:
// fixture builds only consume SDK + core, so a runtime-only change should
// not force a fixture rebuild.
const SENTINEL_TARGETS: readonly { pkg: string }[] = [
	{ pkg: "packages/sdk/dist" },
	{ pkg: "packages/core/dist" },
];

async function walkFiles(
	dir: string,
	out: { path: string; mtimeMs: number; size: number }[],
	rootForKey: string,
): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(full, out, rootForKey);
		} else if (entry.isFile()) {
			const st = await stat(full);
			out.push({
				path: full.slice(rootForKey.length + 1),
				mtimeMs: Math.trunc(st.mtimeMs),
				size: st.size,
			});
		}
	}
}

async function computeSentinel(): Promise<string> {
	const manifest: { path: string; mtimeMs: number; size: number }[] = [];
	for (const target of SENTINEL_TARGETS) {
		const dir = join(REPO_ROOT, target.pkg);
		await walkFiles(dir, manifest, REPO_ROOT);
	}
	manifest.sort((a, b) => a.path.localeCompare(b.path));
	const hash = createHash("sha256");
	for (const entry of manifest) {
		hash.update(
			`${entry.path}\0${String(entry.mtimeMs)}\0${String(entry.size)}\n`,
		);
	}
	return hash.digest("hex");
}

async function readStoredSentinel(): Promise<string | null> {
	try {
		return (await readFile(SENTINEL_FILE, "utf8")).trim();
	} catch {
		return null;
	}
}

// vitest globalSetup hook: invoked once per suite. If the SDK/core dist
// fingerprint differs from the stored sentinel, wipe the cache before any
// test starts. After a wipe the sentinel is rewritten with the current
// fingerprint so subsequent runs hit the cache.
async function syncSentinel(): Promise<void> {
	const current = await computeSentinel();
	const stored = await readStoredSentinel();
	if (stored === current) {
		return;
	}
	await rm(CACHE_DIR, { recursive: true, force: true });
	const { mkdir } = await import("node:fs/promises");
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(SENTINEL_FILE, current, "utf8");
}

interface FixtureKeyInput {
	workflows: readonly { name: string; source: string }[];
	buildEnv: Record<string, string>;
}

// Per-fixture key. Hashes the full set of workflows (name + source) plus
// the sorted buildEnv. owner/repo are deliberately excluded — they only
// matter at upload time; the same source + env produces the same bundle
// regardless of which (owner, repo) tuple it ends up registered under.
function fixtureKey(input: FixtureKeyInput): string {
	const sorted = [...input.workflows].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const envEntries = Object.entries(input.buildEnv).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const hash = createHash("sha256");
	for (const wf of sorted) {
		hash.update(`workflow\0${wf.name}\0${wf.source}\n`);
	}
	for (const [k, v] of envEntries) {
		hash.update(`env\0${k}\0${v}\n`);
	}
	return hash.digest("hex").slice(0, 32);
}

function fixtureCachePath(key: string): string {
	return join(CACHE_DIR, key);
}

async function fixtureCacheHit(key: string): Promise<boolean> {
	try {
		await access(join(fixtureCachePath(key), "dist"));
		return true;
	} catch {
		return false;
	}
}

export type { FixtureKeyInput };
export {
	CACHE_DIR,
	fixtureCacheHit,
	fixtureCachePath,
	fixtureKey,
	syncSentinel,
};
