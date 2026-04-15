import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { build, NoWorkflowsFoundError } from "./build.js";

const TRAILING_SLASHES = /\/+$/;

interface UploadOptions {
	cwd: string;
	url: string;
}

interface UploadResult {
	uploaded: number;
	failed: number;
}

interface ManifestIssue {
	path: Array<string | number>;
	message: string;
}

interface ErrorBody {
	error?: unknown;
	issues?: unknown;
}

interface BundleFailure {
	name: string;
	status: number | "network-error";
	error: string;
	issues?: ManifestIssue[];
}

async function findBundles(
	distDir: string,
): Promise<Array<{ name: string; path: string }>> {
	const entries: Array<{ name: string; path: string }> = [];
	let subdirs: string[];
	try {
		const list = await readdir(distDir, { withFileTypes: true });
		subdirs = list.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
	for (const sub of subdirs.sort()) {
		const bundlePath = join(distDir, sub, "bundle.tar.gz");
		try {
			// biome-ignore lint/performance/noAwaitInLoops: sequential discovery
			await readFile(bundlePath);
			entries.push({ name: sub, path: bundlePath });
		} catch {
			// no bundle in this subdir, skip
		}
	}
	return entries;
}

function parseManifestIssues(value: unknown): ManifestIssue[] | undefined {
	if (!Array.isArray(value)) {
		return;
	}
	const result: ManifestIssue[] = [];
	for (const item of value) {
		if (
			item &&
			typeof item === "object" &&
			"path" in item &&
			"message" in item &&
			Array.isArray((item as { path: unknown }).path) &&
			typeof (item as { message: unknown }).message === "string"
		) {
			const rawPath = (item as { path: unknown[] }).path;
			const path = rawPath.filter(
				(p): p is string | number =>
					typeof p === "string" || typeof p === "number",
			);
			result.push({ path, message: (item as { message: string }).message });
		}
	}
	return result.length > 0 ? result : undefined;
}

async function extractErrorBody(response: Response): Promise<{
	error: string;
	issues?: ManifestIssue[];
}> {
	let parsed: ErrorBody | undefined;
	try {
		parsed = (await response.json()) as ErrorBody;
	} catch {
		return { error: response.statusText || `HTTP ${String(response.status)}` };
	}
	const error =
		typeof parsed.error === "string"
			? parsed.error
			: response.statusText || `HTTP ${String(response.status)}`;
	const issues = parseManifestIssues(parsed.issues);
	return issues ? { error, issues } : { error };
}

function formatIssuePath(path: Array<string | number>): string {
	if (path.length === 0) {
		return "(root)";
	}
	const parts: string[] = [];
	for (let i = 0; i < path.length; i++) {
		const segment = path[i];
		if (typeof segment === "number") {
			parts.push(`[${String(segment)}]`);
		} else if (i === 0) {
			parts.push(String(segment));
		} else {
			parts.push(`.${String(segment)}`);
		}
	}
	return parts.join("");
}

function formatFailure(failure: BundleFailure): string {
	const lines = [`✗ ${failure.name}`];
	lines.push(`    status: ${String(failure.status)}`);
	lines.push(`    error: ${failure.error}`);
	if (failure.issues && failure.issues.length > 0) {
		lines.push("    issues:");
		for (const issue of failure.issues) {
			lines.push(`      ${formatIssuePath(issue.path)}: ${issue.message}`);
		}
	}
	return lines.join("\n");
}

async function uploadBundle(
	url: string,
	name: string,
	path: string,
	token: string | undefined,
): Promise<BundleFailure | null> {
	const body = await readFile(path);
	const headers: Record<string, string> = {
		"Content-Type": "application/gzip",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	let response: Response;
	try {
		response = await fetch(
			`${url.replace(TRAILING_SLASHES, "")}/api/workflows`,
			{
				method: "POST",
				headers,
				body,
			},
		);
	} catch (error) {
		return {
			name,
			status: "network-error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.ok) {
		return null;
	}
	const { error, issues } = await extractErrorBody(response);
	return issues
		? { name, status: response.status, error, issues }
		: { name, status: response.status, error };
}

async function upload(options: UploadOptions): Promise<UploadResult> {
	await build({ cwd: options.cwd });

	const distDir = join(options.cwd, "dist");
	const bundles = await findBundles(distDir);
	if (bundles.length === 0) {
		throw new NoWorkflowsFoundError(
			`no bundles found under ${distDir} after build`,
		);
	}

	// biome-ignore lint/style/noProcessEnv: reading GITHUB_TOKEN is the documented auth input
	const token = process.env.GITHUB_TOKEN?.trim();
	const tokenOrUndefined = token && token.length > 0 ? token : undefined;

	let uploaded = 0;
	let failed = 0;

	for (const bundle of bundles) {
		// biome-ignore lint/performance/noAwaitInLoops: sequential for deterministic output
		const failure = await uploadBundle(
			options.url,
			bundle.name,
			bundle.path,
			tokenOrUndefined,
		);
		if (failure === null) {
			// biome-ignore lint/suspicious/noConsole: user-facing CLI output
			console.error(`✓ ${bundle.name}`);
			uploaded++;
		} else {
			// biome-ignore lint/suspicious/noConsole: user-facing CLI output
			console.error(formatFailure(failure));
			failed++;
		}
	}

	// biome-ignore lint/suspicious/noConsole: user-facing CLI output
	console.error(`Uploaded: ${String(uploaded)}`);
	// biome-ignore lint/suspicious/noConsole: user-facing CLI output
	console.error(`Failed: ${String(failed)}`);

	return { uploaded, failed };
}

export type { UploadOptions, UploadResult };
export { upload };
