import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build.js";
import {
	MissingSecretEnvError,
	PublicKeyFetchError,
	sealBundleIfNeeded,
} from "./seal.js";

const TRAILING_SLASHES = /\/+$/;
const TENANT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

interface UploadOptions {
	cwd: string;
	url: string;
	tenant: string;
	user?: string;
	token?: string;
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

async function uploadBundleBytes(
	url: string,
	tenant: string,
	body: Uint8Array,
	auth: { user?: string | undefined; token?: string | undefined },
): Promise<UploadFailure | null> {
	const headers: Record<string, string> = {
		"Content-Type": "application/gzip",
	};
	if (auth.user) {
		headers["X-Auth-Provider"] = "local";
		headers.Authorization = `User ${auth.user}`;
	} else if (auth.token) {
		headers["X-Auth-Provider"] = "github";
		headers.Authorization = `Bearer ${auth.token}`;
	}
	let response: Response;
	try {
		response = await fetch(
			`${url.replace(TRAILING_SLASHES, "")}/api/workflows/${tenant}`,
			{
				method: "POST",
				headers,
				body: body as BodyInit,
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

function sealFailureToUploadFailure(
	err: unknown,
	tenant: string,
): UploadFailure {
	if (err instanceof MissingSecretEnvError) {
		return { tenant, status: "network-error", error: err.message };
	}
	if (err instanceof PublicKeyFetchError) {
		return { tenant, status: err.status, error: err.message };
	}
	return {
		tenant,
		status: "network-error",
		error: err instanceof Error ? err.message : String(err),
	};
}

async function upload(options: UploadOptions): Promise<UploadResult> {
	if (options.user !== undefined && options.token !== undefined) {
		throw new Error(
			"user and token are mutually exclusive: pass only one of --user or --token",
		);
	}

	if (!TENANT_RE.test(options.tenant)) {
		throw new Error(
			`tenant "${options.tenant}" must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,62}`,
		);
	}

	await build({ cwd: options.cwd });

	const bundlePath = join(options.cwd, "dist", "bundle.tar.gz");
	const bundleBytes = await readFile(bundlePath);

	let resolvedToken = options.token;
	if (resolvedToken === undefined && options.user === undefined) {
		// biome-ignore lint/style/noProcessEnv: reading GITHUB_TOKEN is the documented auth input
		const envToken = process.env.GITHUB_TOKEN?.trim();
		resolvedToken = envToken && envToken.length > 0 ? envToken : undefined;
	}

	const auth = { user: options.user, token: resolvedToken };

	let toUpload: Uint8Array = bundleBytes;
	try {
		// Sealing fetches the public-key endpoint — server-side auth is the
		// same bearer/user pair the upload will use.
		toUpload = await sealBundleIfNeeded(bundleBytes, {
			url: options.url,
			tenant: options.tenant,
			auth,
		});
	} catch (err) {
		const failure = sealFailureToUploadFailure(err, options.tenant);
		// biome-ignore lint/suspicious/noConsole: user-facing CLI output
		console.error(formatFailure(failure));
		return { uploaded: 0, failed: 1 };
	}

	const failure = await uploadBundleBytes(
		options.url,
		options.tenant,
		toUpload,
		auth,
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
