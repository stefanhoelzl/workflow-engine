#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { build, NoWorkflowsFoundError } from "./build.js";
import { detectGitRemote } from "./git-remote.js";
import { upload } from "./upload.js";

const DEFAULT_URL = "https://workflow-engine.webredirect.org";
const REPO_FLAG_RE = /^([^/]+)\/([^/]+)$/;

interface ResolvedScope {
	readonly owner: string;
	readonly repo: string;
}

async function resolveScope(
	cwd: string,
	repoFlag: string | undefined,
): Promise<ResolvedScope> {
	if (repoFlag !== undefined) {
		const match = REPO_FLAG_RE.exec(repoFlag);
		if (!match) {
			throw new Error(
				`--repo must be in "owner/name" form (got "${repoFlag}")`,
			);
		}
		return { owner: match[1] ?? "", repo: match[2] ?? "" };
	}
	const detected = await detectGitRemote(cwd);
	if (detected) {
		return detected;
	}
	throw new Error(
		"could not determine owner/repo: pass --repo <owner>/<name> or run from a github.com checkout",
	);
}

const uploadCommand = defineCommand({
	meta: {
		name: "upload",
		description: "Build workflows in cwd and upload them to a runtime",
	},
	args: {
		url: {
			type: "string",
			description: "Target runtime URL",
			default: DEFAULT_URL,
		},
		repo: {
			type: "string",
			description:
				"Target owner/name (defaults to `git remote get-url origin` on github.com)",
		},
		user: {
			type: "string",
			description:
				"Local dev provider user (mutually exclusive with GITHUB_TOKEN)",
		},
	},
	async run({ args }) {
		const cwd = process.cwd();
		let scope: ResolvedScope;
		try {
			scope = await resolveScope(cwd, args.repo);
		} catch (err) {
			// biome-ignore lint/suspicious/noConsole: user-facing CLI output
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
		try {
			const { failed } = await upload({
				cwd,
				url: args.url,
				owner: scope.owner,
				repo: scope.repo,
				...(args.user ? { user: args.user } : {}),
			});
			process.exit(failed === 0 ? 0 : 1);
		} catch (error) {
			if (error instanceof NoWorkflowsFoundError) {
				// biome-ignore lint/suspicious/noConsole: user-facing CLI output
				console.error("no workflows found in src/");
				process.exit(1);
			}
			// biome-ignore lint/suspicious/noConsole: user-facing CLI output
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	},
});

const buildCommand = defineCommand({
	meta: {
		name: "build",
		description: "Build workflows in cwd into dist/bundle.tar.gz (no upload)",
	},
	async run() {
		try {
			await build({ cwd: process.cwd() });
			process.exit(0);
		} catch (error) {
			if (error instanceof NoWorkflowsFoundError) {
				// biome-ignore lint/suspicious/noConsole: user-facing CLI output
				console.error("no workflows found in src/");
				process.exit(1);
			}
			// biome-ignore lint/suspicious/noConsole: user-facing CLI output
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	},
});

const main = defineCommand({
	meta: {
		name: "wfe",
		version: "0.1.0",
		description: "workflow-engine CLI",
	},
	subCommands: {
		upload: uploadCommand,
		build: buildCommand,
	},
});

runMain(main);
