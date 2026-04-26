import { OWNER_NAME_RE, REPO_NAME_RE } from "@workflow-engine/core";
import { bundle, MissingSecretEnvError } from "./bundle.js";
import { PublicKeyFetchError } from "./seal-http.js";

const TRAILING_SLASHES = /\/+$/;

interface UploadOptions {
	cwd: string;
	url: string;
	owner: string;
	repo: string;
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
	owner: string;
	repo: string;
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
	const lines = [`✗ ${failure.owner}/${failure.repo}`];
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

// biome-ignore lint/complexity/useMaxParams: orthogonal inputs (url, owner, repo, body, auth); the call is internal to this module
async function uploadBundleBytes(
	url: string,
	owner: string,
	repo: string,
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
	const endpoint = `${url.replace(TRAILING_SLASHES, "")}/api/workflows/${owner}/${repo}`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: body as BodyInit,
		});
	} catch (error) {
		return {
			owner,
			repo,
			status: "network-error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.ok) {
		return null;
	}
	const { error, issues } = await extractErrorBody(response);
	return issues
		? { owner, repo, status: response.status, error, issues }
		: { owner, repo, status: response.status, error };
}

function bundleFailureToUploadFailure(
	err: unknown,
	owner: string,
	repo: string,
): UploadFailure {
	if (err instanceof MissingSecretEnvError) {
		return { owner, repo, status: "network-error", error: err.message };
	}
	if (err instanceof PublicKeyFetchError) {
		return { owner, repo, status: err.status, error: err.message };
	}
	return {
		owner,
		repo,
		status: "network-error",
		error: err instanceof Error ? err.message : String(err),
	};
}

function resolveAuth(options: UploadOptions): {
	user: string | undefined;
	token: string | undefined;
} {
	if (options.user !== undefined && options.token !== undefined) {
		throw new Error(
			"user and token are mutually exclusive: pass only one of --user or --token",
		);
	}

	// biome-ignore lint/style/noProcessEnv: reading GITHUB_TOKEN is the documented auth input
	const envToken = process.env.GITHUB_TOKEN?.trim();
	const envTokenValue = envToken && envToken.length > 0 ? envToken : undefined;

	if (options.user !== undefined && envTokenValue !== undefined) {
		throw new Error(
			"user and GITHUB_TOKEN are mutually exclusive: unset GITHUB_TOKEN or omit --user",
		);
	}

	return { user: options.user, token: options.token ?? envTokenValue };
}

async function upload(options: UploadOptions): Promise<UploadResult> {
	const auth = resolveAuth(options);

	if (!OWNER_NAME_RE.test(options.owner)) {
		throw new Error(
			`owner "${options.owner}" must match ${OWNER_NAME_RE.source}`,
		);
	}
	if (!REPO_NAME_RE.test(options.repo)) {
		throw new Error(`repo "${options.repo}" must match ${REPO_NAME_RE.source}`);
	}

	let tarBytes: Uint8Array;
	try {
		tarBytes = await bundle({
			cwd: options.cwd,
			url: options.url,
			owner: options.owner,
			user: auth.user,
			token: auth.token,
		});
	} catch (err) {
		const failure = bundleFailureToUploadFailure(
			err,
			options.owner,
			options.repo,
		);
		// biome-ignore lint/suspicious/noConsole: user-facing CLI output
		console.error(formatFailure(failure));
		return { uploaded: 0, failed: 1 };
	}

	const failure = await uploadBundleBytes(
		options.url,
		options.owner,
		options.repo,
		tarBytes,
		auth,
	);
	if (failure === null) {
		// biome-ignore lint/suspicious/noConsole: user-facing CLI output
		console.error(`✓ ${options.owner}/${options.repo}`);
		return { uploaded: 1, failed: 0 };
	}
	// biome-ignore lint/suspicious/noConsole: user-facing CLI output
	console.error(formatFailure(failure));
	return { uploaded: 0, failed: 1 };
}

export type { UploadOptions, UploadResult };
export { upload };
