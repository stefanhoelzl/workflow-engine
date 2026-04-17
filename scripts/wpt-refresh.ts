// Vendor the worker-scope subset of web-platform-tests/wpt into the
// sandbox package. Walks the upstream tree, classifies every candidate
// file via spec.ts, copies pass-classified files plus their transitive
// META dependencies into vendor/, and writes a manifest.json describing
// every applicable test (runnable or structurally-skipped).
//
// Invoke: pnpm test:wpt:refresh [--sha <commit>] [--strict]

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
import { findMostSpecific } from "../packages/sandbox/test/wpt/harness/match.js";
import { spec } from "../packages/sandbox/test/wpt/spec.js";

// --- Config ---

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const VENDOR_DIR = resolve(ROOT, "packages/sandbox/test/wpt/vendor");
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
	strict: boolean;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	let sha: string | null = null;
	let strict = false;
	// biome-ignore lint/style/useForOf: index-based loop advances i++ to consume "--sha <value>" pairs
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--sha") {
			sha = argv[++i] ?? null;
		} else if (a?.startsWith("--sha=")) {
			sha = a.slice("--sha=".length);
		} else if (a === "--strict") {
			strict = true;
		} else if (a === "--help" || a === "-h") {
			printUsage();
			process.exit(0);
		} else {
			console.error(`unknown argument: ${a}`);
			printUsage();
			process.exit(2);
		}
	}
	return { sha, strict };
}

function printUsage(): void {
	console.log(
		`usage: pnpm test:wpt:refresh [--sha <commit>] [--strict]

Regenerates packages/sandbox/test/wpt/vendor/ from upstream WPT.

Options:
  --sha <commit>   Pin to a specific upstream commit (default: latest main).
  --strict         Fail if any spec.ts-referenced subtest or file no longer
                   exists in upstream.
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
	globals: string[] | null; // null = absent; worker-default applies
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
		// META directives only appear at the top; stop at first non-META non-blank.
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
		return true; // WPT default includes workers
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
	// Absolute paths (leading /) are relative to WPT root.
	if (ref.startsWith("/")) {
		return ref.slice(1);
	}
	// Relative paths are relative to the file's directory.
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

	// testharness.js is implicit for every .any.js / .worker.js file.
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
	skippedSubtests?: Record<string, string>;
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

function collectSkippedSubtests(
	fileRel: string,
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const key of Object.keys(spec)) {
		const [filePart, ...rest] = key.split(":");
		if (filePart !== fileRel) {
			continue;
		}
		if (rest.length === 0) {
			continue;
		}
		const subtestName = rest.join(":");
		const entry = spec[key];
		if (entry && entry.expected === "skip") {
			out[subtestName] = entry.reason;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: orchestrator groups the top-level refresh flow
async function main(): Promise<void> {
	const { sha, strict } = parseArgs();
	const { repoDir, resolvedSha } = gitClone(sha);

	// Fresh vendor dir each run.
	if (existsSync(VENDOR_DIR)) {
		rmSync(VENDOR_DIR, { recursive: true });
	}
	mkdirSync(VENDOR_DIR, { recursive: true });

	const tests: Record<string, ManifestTest> = {};
	const runnableFiles: Array<{ rel: string; substituted: string | null }> = [];
	const runnableDeps = new Map<string, string>(); // dep rel -> substituted source
	let applicable = 0;
	let skippedUnclassified = 0;
	let skippedStructural = 0;
	let runnable = 0;

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

		// Structural skip: transitive network dep?
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

		// Spec classification.
		const exp = findMostSpecific(spec, fileRel);
		if (!exp || exp.expected === "skip") {
			// Not vendored. Manifest records just the file path with classification
			// reason via spec, or as unclassified if no match. The runner re-derives
			// the reason from spec.ts at test time; we don't stamp it here.
			tests[fileRel] = {
				skip: { reason: exp?.reason ?? "not yet classified" },
			};
			if (!exp) {
				skippedUnclassified++;
			}
			continue;
		}

		// Runnable. Copy file + deps to vendor.
		const entry: RunnableEntry = { scripts: deps };
		if (meta.timeout === "long") {
			entry.timeout = "long";
		}
		const subOverrides = collectSkippedSubtests(fileRel);
		if (subOverrides) {
			entry.skippedSubtests = subOverrides;
		}
		tests[fileRel] = entry;
		runnableFiles.push({
			rel: fileRel,
			substituted: fileRel.endsWith(".sub.js") ? substFile : null,
		});
		for (const d of deps) {
			if (!runnableDeps.has(d)) {
				runnableDeps.set(d, substituted.get(d) ?? "");
			}
		}
		runnable++;
	}

	console.log(
		`applicable=${applicable} runnable=${runnable} structural-skip=${skippedStructural} unclassified=${skippedUnclassified}`,
	);

	// Copy runnable files + deps into vendor/.
	console.log("copying vendor files...");
	for (const f of runnableFiles) {
		copyFileToVendor(repoDir, f.rel, f.substituted);
	}
	for (const [depRel, substituted] of runnableDeps) {
		copyFileToVendor(repoDir, depRel, substituted);
	}

	// Manifest.
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

	// Strict: check every spec subtest reference maps to a vendored file.
	if (strict) {
		const missing: string[] = [];
		for (const key of Object.keys(spec)) {
			const [filePart, ...rest] = key.split(":");
			if (rest.length === 0) {
				continue; // dir/glob patterns, not file-subtest
			}
			if (filePart === undefined) {
				continue;
			}
			if (filePart.includes("*")) {
				continue; // skip wildcard patterns
			}
			if (!tests[filePart]) {
				missing.push(key);
			}
		}
		if (missing.length > 0) {
			console.error(
				"--strict: spec.ts references subtests in files no longer in the vendor:",
			);
			for (const k of missing) {
				console.error(`  - ${k}`);
			}
			process.exit(1);
		}
	}

	// Clean up temp clone.
	rmSync(repoDir, { recursive: true, force: true });

	console.log(`done. vendor at ${relative(ROOT, VENDOR_DIR)}/`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
