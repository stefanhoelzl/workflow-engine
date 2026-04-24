import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Git remote → `{ owner, repo }` parser
// ---------------------------------------------------------------------------
//
// Accepts the URL formats git itself emits for GitHub remotes:
//   - HTTPS:         https://github.com/owner/repo.git
//   - HTTPS w/ user: https://token@github.com/owner/repo
//   - SSH (colon):   git@github.com:owner/repo.git
//   - SSH (proto):   ssh://git@github.com/owner/repo.git
//
// The `.git` suffix is optional. Any host other than `github.com` returns
// `undefined` so a user whose `origin` points at GitLab, Bitbucket, or
// GitHub Enterprise falls through to the explicit `--repo` flag path — we
// never guess cross-host identities.

interface Parsed {
	readonly owner: string;
	readonly repo: string;
}

const SSH_COLON_RE = /^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i;
const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;
const URL_LIKE_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);

function stripGitSuffix(s: string): string {
	return s.endsWith(".git") ? s.slice(0, -".git".length) : s;
}

function parseSshColon(trimmed: string): Parsed | undefined {
	const m = SSH_COLON_RE.exec(trimmed);
	if (!m) {
		return;
	}
	const owner = m[1];
	const repoRaw = m[2];
	if (!(owner && repoRaw)) {
		return;
	}
	const repo = stripGitSuffix(repoRaw);
	if (!repo) {
		return;
	}
	return { owner, repo };
}

function parseUrlLike(trimmed: string): Parsed | undefined {
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return;
	}
	if (!URL_LIKE_PROTOCOLS.has(parsed.protocol)) {
		return;
	}
	if (parsed.hostname.toLowerCase() !== "github.com") {
		return;
	}
	const path = parsed.pathname
		.replace(LEADING_SLASHES_RE, "")
		.replace(TRAILING_SLASHES_RE, "");
	if (path === "") {
		return;
	}
	const parts = path.split("/");
	if (parts.length !== 2) {
		return;
	}
	const [ownerPart, repoPart] = parts as [string, string];
	const repo = stripGitSuffix(repoPart);
	if (!(ownerPart && repo)) {
		return;
	}
	return { owner: ownerPart, repo };
}

function parseGitRemoteUrl(raw: string): Parsed | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return;
	}
	if (!trimmed.includes("://")) {
		return parseSshColon(trimmed);
	}
	return parseUrlLike(trimmed);
}

async function detectGitRemote(cwd: string): Promise<Parsed | undefined> {
	let stdout: string;
	try {
		const result = await execFile("git", ["remote", "get-url", "origin"], {
			cwd,
		});
		stdout = result.stdout;
	} catch {
		return;
	}
	return parseGitRemoteUrl(stdout);
}

export type { Parsed };
export { detectGitRemote, parseGitRemoteUrl };
