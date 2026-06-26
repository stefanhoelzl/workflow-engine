#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { build, NoWorkflowsFoundError } from "./build.js";
import { detectGitRemote } from "./git-remote.js";
import { upload } from "./upload.js";

const DEFAULT_URL = "https://workflow-engine.stho.net";
const REPO_FLAG_RE = /^([^/]+)\/([^/]+)$/;

interface ResolvedScope {
	readonly owner: string;
	readonly repo: string;
}

function collectKnownArgKeys(
	argsDef: Readonly<Record<string, object>>,
): Set<string> {
	const known = new Set<string>(["_"]);
	for (const [name, def] of Object.entries(argsDef)) {
		known.add(name);
		const alias = (def as { alias?: string | readonly string[] }).alias;
		if (typeof alias === "string") {
			known.add(alias);
		} else if (Array.isArray(alias)) {
			for (const a of alias) {
				known.add(a);
			}
		}
	}
	return known;
}

function assertNoUnknownArgs(
	args: Record<string, unknown>,
	argsDef: Readonly<Record<string, object>>,
): void {
	const known = collectKnownArgKeys(argsDef);
	for (const key of Object.keys(args)) {
		if (!known.has(key)) {
			const prefix = key.length === 1 ? "-" : "--";
			throw new Error(`unknown option: ${prefix}${key}`);
		}
	}
	const positionals = args._;
	if (Array.isArray(positionals) && positionals.length > 0) {
		throw new Error(`unexpected argument: ${positionals[0]}`);
	}
}

function failOnArgsError(error: unknown, subcommand: string): never {
	// biome-ignore lint/suspicious/noConsole: user-facing CLI output
	console.error(error instanceof Error ? error.message : String(error));
	// biome-ignore lint/suspicious/noConsole: user-facing CLI output
	console.error(`run \`wfe ${subcommand} --help\` to see valid options`);
	process.exit(1);
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

const uploadArgs = {
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
} as const;

const uploadCommand = defineCommand({
	meta: {
		name: "upload",
		description: "Build workflows in cwd and upload them to a runtime",
	},
	args: uploadArgs,
	async run({ args }) {
		try {
			assertNoUnknownArgs(args as Record<string, unknown>, uploadArgs);
		} catch (err) {
			failOnArgsError(err, "upload");
		}
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

const buildArgs = {} as const;

const buildCommand = defineCommand({
	meta: {
		name: "build",
		description:
			"Compile workflows in cwd to dist/<name>.js (no manifest, no tar, no network)",
	},
	args: buildArgs,
	async run({ args }) {
		try {
			assertNoUnknownArgs(args as Record<string, unknown>, buildArgs);
		} catch (err) {
			failOnArgsError(err, "build");
		}
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
