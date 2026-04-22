// Vendor the worker-scope subset of web-platform-tests/wpt into the
// sandbox package. Walks the upstream tree, copies every applicable file
// (worker-globals-applicable per WPT META) plus its transitive META
// dependencies into vendor/, and writes a manifest.json describing every
// applicable test (runnable or structurally-skipped because of a network
// dep). Spec-level skips (skip.ts) are applied at runtime, not here.
//
// Invoke: pnpm test:wpt:refresh [--sha <commit>]
//
// Refresh fails if any literal-path entry in skip.ts no longer points to
// an applicable upstream file (catches renames/deletions early).

import { execSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import skip from "../packages/sandbox-stdlib/test/wpt/skip.js";

// --- Config ---

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const VENDOR_DIR = resolve(ROOT, "packages/sandbox-stdlib/test/wpt/vendor");
const WPT_REPO = "https://github.com/web-platform-tests/wpt.git";
const TEST_SUFFIXES = [
	".any.js",
	".any.https.js",
	".worker.js",
	".worker.https.js",
] as const;
const WORKER_GLOBALS = new Set([
	"worker",
	"dedicatedworker",
	"sharedworker",
	"serviceworker",
	"shadowrealm",
]);
const TESTHARNESS_REL = "resources/testharness.js";
const SUB_PLACEHOLDERS: Record<string, string> = {
	"{{host}}": "web-platform.test",
	"{{hosts[alt][www]}}": "www.web-platform.test",
	"{{hosts[][www]}}": "www.web-platform.test",
	"{{ports[http][0]}}": "8000",
	"{{ports[http][1]}}": "8001",
	"{{ports[https][0]}}": "8443",
	"{{ports[ws][0]}}": "8666",
	"{{ports[wss][0]}}": "8667",
};
const NETWORK_DEP_PATTERN = /\{\{(host|ports|hosts|domains)[^}]*\}\}/;

// --- CLI ---

interface Args {
	sha: string | null;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	let sha: string | null = null;
	// biome-ignore lint/style/useForOf: index-based loop advances i++ to consume "--sha <value>" pairs
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--sha") {
			sha = argv[++i] ?? null;
		} else if (a?.startsWith("--sha=")) {
			sha = a.slice("--sha=".length);
		} else if (a === "--help" || a === "-h") {
			printUsage();
			process.exit(0);
		} else {
			console.error(`unknown argument: ${a}`);
			printUsage();
			process.exit(2);
		}
	}
	return { sha };
}

function printUsage(): void {
	console.log(
		`usage: pnpm test:wpt:refresh [--sha <commit>]

Regenerates packages/sandbox-stdlib/test/wpt/vendor/ from upstream WPT.

Options:
  --sha <commit>   Pin to a specific upstream commit (default: latest main).

Refresh fails if any literal-path entry in skip.ts no longer points to an
applicable upstream file (renames/deletions surface immediately).
`,
	);
}

// --- Git clone ---

function gitClone(targetSha: string | null): {
	repoDir: string;
	resolvedSha: string;
} {
	const repoDir = mkdtempSync(join(tmpdir(), "wpt-refresh-"));
	console.log(`cloning ${WPT_REPO} to ${repoDir}...`);
	if (targetSha) {
		execSync(`git clone ${WPT_REPO} ${repoDir}`, { stdio: "inherit" });
		execSync(`git -C ${repoDir} checkout ${targetSha}`, { stdio: "inherit" });
	} else {
		execSync(`git clone --depth 1 ${WPT_REPO} ${repoDir}`, {
			stdio: "inherit",
		});
	}
	const resolved = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
		encoding: "utf8",
	});
	const resolvedSha = resolved.stdout.trim();
	console.log(`WPT at ${resolvedSha}`);
	return { repoDir, resolvedSha };
}

// --- File enumeration ---

function* walkTestFiles(dir: string, root: string): Generator<string> {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === ".git" || entry.name === "node_modules") {
				continue;
			}
			yield* walkTestFiles(abs, root);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		if (!TEST_SUFFIXES.some((s) => entry.name.endsWith(s))) {
			continue;
		}
		yield relative(root, abs);
	}
}

// --- META parsing ---

interface Meta {
	globals: string[] | null;
	scripts: string[];
	timeout: "long" | null;
	variants: string[];
}

const META_LINE_RE = /^\s*\/\/\s*META:\s*([a-zA-Z_-]+)\s*=\s*(.+)\s*$/;

function parseMeta(source: string): Meta {
	const meta: Meta = {
		globals: null,
		scripts: [],
		timeout: null,
		variants: [],
	};
	const lines = source.split("\n");
	for (const line of lines) {
		if (!line.startsWith("//")) {
			break;
		}
		const m = line.match(META_LINE_RE);
		if (!m) {
			continue;
		}
		const key = m[1];
		const value = m[2];
		if (!key || value === undefined) {
			continue;
		}
		if (key === "global") {
			meta.globals = value.split(",").map((s) => s.trim().toLowerCase());
		} else if (key === "script") {
			meta.scripts.push(value.trim());
		} else if (key === "timeout") {
			if (value.trim() === "long") {
				meta.timeout = "long";
			}
		} else if (key === "variant") {
			meta.variants.push(value.trim());
		}
	}
	return meta;
}

function isWorkerApplicable(meta: Meta): boolean {
	if (meta.globals === null) {
		return true;
	}
	return meta.globals.some((g) => WORKER_GLOBALS.has(g));
}

// --- Substitution ---

function applySubstitutions(source: string): string {
	let out = source;
	for (const [placeholder, value] of Object.entries(SUB_PLACEHOLDERS)) {
		out = out.split(placeholder).join(value);
	}
	return out;
}

function hasNetworkDep(source: string): boolean {
	return NETWORK_DEP_PATTERN.test(source);
}

// --- Dep resolution (BFS) ---

function resolveScriptPath(ref: string, fromFileRel: string): string {
	if (ref.startsWith("/")) {
		return ref.slice(1);
	}
	return join(dirname(fromFileRel), ref);
}

function resolveDeps(
	repoRoot: string,
	fileRel: string,
	initialMeta: Meta,
): { deps: string[]; substituted: Map<string, string> } {
	const seen = new Set<string>();
	const order: string[] = [];
	const substituted = new Map<string, string>();

	const queue: Array<{ ref: string; from: string }> = [
		{ ref: `/${TESTHARNESS_REL}`, from: fileRel },
	];
	for (const s of initialMeta.scripts) {
		queue.push({ ref: s, from: fileRel });
	}

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}
		const resolved = resolveScriptPath(item.ref, item.from);
		if (seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);
		const abs = join(repoRoot, resolved);
		if (!existsSync(abs)) {
			continue;
		}
		let src: string;
		try {
			src = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		if (resolved.endsWith(".sub.js") || resolved.endsWith(".sub.any.js")) {
			src = applySubstitutions(src);
		}
		substituted.set(resolved, src);
		order.push(resolved);
		const childMeta = parseMeta(src);
		for (const s of childMeta.scripts) {
			queue.push({ ref: s, from: resolved });
		}
	}

	return { deps: order, substituted };
}

// --- Manifest + vendor copy ---

interface RunnableEntry {
	scripts: string[];
	timeout?: "long";
}
interface SkipEntry {
	skip: { reason: string };
}
type ManifestTest = RunnableEntry | SkipEntry;

interface Manifest {
	wptSha: string;
	vendoredAt: string;
	tests: Record<string, ManifestTest>;
}

function copyFileToVendor(
	repoRoot: string,
	rel: string,
	contentOverride: string | null,
): void {
	const target = join(VENDOR_DIR, rel);
	mkdirSync(dirname(target), { recursive: true });
	if (contentOverride === null) {
		cpSync(join(repoRoot, rel), target);
	} else {
		writeFileSync(target, contentOverride);
	}
}

// --- Main orchestration ---

async function main(): Promise<void> {
	const { sha } = parseArgs();
	const { repoDir, resolvedSha } = gitClone(sha);

	if (existsSync(VENDOR_DIR)) {
		rmSync(VENDOR_DIR, { recursive: true });
	}
	mkdirSync(VENDOR_DIR, { recursive: true });

	const tests: Record<string, ManifestTest> = {};
	const vendoredFiles: Array<{ rel: string; substituted: string | null }> = [];
	const vendoredDeps = new Map<string, string>();
	const applicableFiles = new Set<string>();
	let applicable = 0;
	let runnable = 0;
	let skippedStructural = 0;

	console.log("walking WPT tree...");
	for (const fileRel of walkTestFiles(repoDir, repoDir)) {
		const abs = join(repoDir, fileRel);
		let source: string;
		try {
			source = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		const meta = parseMeta(source);
		if (!isWorkerApplicable(meta)) {
			continue;
		}
		applicable++;
		applicableFiles.add(fileRel);

		const { deps, substituted } = resolveDeps(repoDir, fileRel, meta);
		const substFile = fileRel.endsWith(".sub.js")
			? applySubstitutions(source)
			: source;
		const allSources = [
			substFile,
			...deps.map((d) => substituted.get(d) ?? ""),
		];
		if (allSources.some(hasNetworkDep)) {
			tests[fileRel] = {
				skip: {
					reason: "contains {{host}}/{{ports}} network dependency",
				},
			};
			skippedStructural++;
			continue;
		}

		// Runnable. Vendor the file + deps regardless of skip.ts — runtime
		// applies skip.ts via findMostSpecific.
		const entry: RunnableEntry = { scripts: deps };
		if (meta.timeout === "long") {
			entry.timeout = "long";
		}
		tests[fileRel] = entry;
		vendoredFiles.push({
			rel: fileRel,
			substituted: fileRel.endsWith(".sub.js") ? substFile : null,
		});
		for (const d of deps) {
			if (!vendoredDeps.has(d)) {
				vendoredDeps.set(d, substituted.get(d) ?? "");
			}
		}
		runnable++;
	}

	console.log(
		`applicable=${applicable} runnable=${runnable} structural-skip=${skippedStructural}`,
	);

	console.log("copying vendor files...");
	for (const f of vendoredFiles) {
		copyFileToVendor(repoDir, f.rel, f.substituted);
	}
	for (const [depRel, substituted] of vendoredDeps) {
		copyFileToVendor(repoDir, depRel, substituted);
	}

	const manifest: Manifest = {
		wptSha: resolvedSha,
		vendoredAt: new Date().toISOString(),
		tests,
	};
	writeFileSync(
		join(VENDOR_DIR, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	console.log(`manifest: ${Object.keys(tests).length} entries`);

	// Validate: every literal-path skip entry must point to an applicable file.
	const stale: string[] = [];
	for (const key of Object.keys(skip)) {
		const filePart = key.split(":")[0];
		if (filePart === undefined || filePart.includes("*")) {
			continue;
		}
		if (!applicableFiles.has(filePart)) {
			stale.push(key);
		}
	}
	if (stale.length > 0) {
		console.error("skip.ts references files no longer in upstream WPT:");
		for (const k of stale) {
			console.error(`  - ${k}`);
		}
		rmSync(repoDir, { recursive: true, force: true });
		process.exit(1);
	}

	rmSync(repoDir, { recursive: true, force: true });

	console.log(`done. vendor at ${relative(ROOT, VENDOR_DIR)}/`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
