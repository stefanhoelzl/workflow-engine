import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build.js";

const TRAILING_SLASHES = /\/+$/;
const TENANT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

interface UploadOptions {
	cwd: string;
	url: string;
	tenant: string;
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

interface UploadFailure {
	tenant: string;
	status: number | "network-error";
	error: string;
	issues?: ManifestIssue[];
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

function formatFailure(failure: UploadFailure): string {
	const lines = [`✗ ${failure.tenant}`];
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
	tenant: string,
	path: string,
	token: string | undefined,
): Promise<UploadFailure | null> {
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
			`${url.replace(TRAILING_SLASHES, "")}/api/workflows/${tenant}`,
			{
				method: "POST",
				headers,
				body,
			},
		);
	} catch (error) {
		return {
			tenant,
			status: "network-error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.ok) {
		return null;
	}
	const { error, issues } = await extractErrorBody(response);
	return issues
		? { tenant, status: response.status, error, issues }
		: { tenant, status: response.status, error };
}

async function upload(options: UploadOptions): Promise<UploadResult> {
	if (!TENANT_RE.test(options.tenant)) {
		throw new Error(
			`tenant "${options.tenant}" must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,62}`,
		);
	}

	await build({ cwd: options.cwd });

	const bundlePath = join(options.cwd, "dist", "bundle.tar.gz");
	// Throws if absent — build() above should have produced it.
	await readFile(bundlePath);

	// biome-ignore lint/style/noProcessEnv: reading GITHUB_TOKEN is the documented auth input
	const token = process.env.GITHUB_TOKEN?.trim();
	const tokenOrUndefined = token && token.length > 0 ? token : undefined;

	const failure = await uploadBundle(
		options.url,
		options.tenant,
		bundlePath,
		tokenOrUndefined,
	);
	if (failure === null) {
		// biome-ignore lint/suspicious/noConsole: user-facing CLI output
		console.error(`✓ ${options.tenant}`);
		return { uploaded: 1, failed: 0 };
	}
	// biome-ignore lint/suspicious/noConsole: user-facing CLI output
	console.error(formatFailure(failure));
	return { uploaded: 0, failed: 1 };
}

export type { UploadOptions, UploadResult };
export { upload };
