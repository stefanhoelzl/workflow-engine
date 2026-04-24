#!/usr/bin/env node
/**
 * Client-side merge queue for /ship command.
 *
 * Waits for PRs ahead in queue, rebases when it's our turn,
 * waits for CI, and confirms merge completion.
 *
 * Usage: pnpx tsx .claude/commands/ship-wait.ts <repo> <pr-number> <default-branch>
 *
 * Exit codes:
 *   0 - MERGED: PR successfully merged
 *   1 - FAILED: PR failed (CI failed, conflicts, closed, etc.)
 *   2 - TIMEOUT: Still processing after 15 minutes
 *
 * Environment:
 *   Requires `gh` CLI to be authenticated.
 */

import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 900_000; // 15 minutes
const MERGE_WAIT_TIMEOUT_MS = 120_000; // 2 minutes
const MERGE_POLL_INTERVAL_MS = 5000;
const COMMAND_TIMEOUT_MS = 60_000;
const CHECKS_APPEAR_POLL_MS = 5000;
const CHECKS_APPEAR_MAX_ATTEMPTS = 12;
const EXPECTED_ARGS = 3;

type FailingConclusion =
	| "FAILURE"
	| "CANCELLED"
	| "TIMED_OUT"
	| "ACTION_REQUIRED";

const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set<FailingConclusion>([
	"FAILURE",
	"CANCELLED",
	"TIMED_OUT",
	"ACTION_REQUIRED",
]);

interface StatusCheck {
	name?: string;
	conclusion?: string | null;
}

interface PullRequest {
	number: number;
	createdAt: string;
	autoMergeRequest: { enabledAt: string } | null;
	state: "OPEN" | "MERGED" | "CLOSED";
	headRefName: string;
	mergeStateStatus?: string;
	statusCheckRollup?: StatusCheck[];
}

interface PullRequestState {
	state: "OPEN" | "MERGED" | "CLOSED";
	mergeStateStatus: string;
}

type SkipReason =
	| { kind: "closed" }
	| { kind: "dirty" }
	| { kind: "check-failed"; checkName: string; conclusion: string };

function formatSkipReason(reason: SkipReason): string {
	if (reason.kind === "closed") {
		return "CLOSED";
	}
	if (reason.kind === "dirty") {
		return "DIRTY";
	}
	return `check '${reason.checkName}' ${reason.conclusion}`;
}

function classifyAhead(pr: PullRequest): SkipReason | null {
	if (pr.state === "CLOSED") {
		return { kind: "closed" };
	}
	if (pr.mergeStateStatus === "DIRTY") {
		return { kind: "dirty" };
	}
	if (pr.mergeStateStatus === "UNKNOWN") {
		return null;
	}
	for (const check of pr.statusCheckRollup ?? []) {
		const conclusion = check.conclusion;
		if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) {
			return {
				kind: "check-failed",
				checkName: check.name ?? "<unnamed>",
				conclusion,
			};
		}
	}
	return null;
}

function log(message: string): void {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function exec(
	command: string,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, [], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: true,
		});

		let stdout = "";
		let stderr = "";

		const timeout = setTimeout(() => {
			proc.kill();
			reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
		}, timeoutMs);

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				reject(new Error(`Command failed: ${command}\n${stderr || stdout}`));
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(new Error(`Command error: ${command}\n${err.message}`));
		});
	});
}

async function execNoThrow(
	command: string,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
	try {
		const stdout = await exec(command, timeoutMs);
		return { success: true, stdout, stderr: "" };
	} catch (error) {
		const err = error as Error;
		return { success: false, stdout: "", stderr: err.message };
	}
}

async function getOpenPrsWithAutoMerge(repo: string): Promise<PullRequest[]> {
	const json = await exec(
		`gh pr list --repo ${repo} --state open --json number,createdAt,autoMergeRequest,state,headRefName,mergeStateStatus,statusCheckRollup`,
	);
	const prs: PullRequest[] = JSON.parse(json);
	return prs.filter((pr) => pr.autoMergeRequest !== null);
}

async function getPrState(
	repo: string,
	prNumber: number,
): Promise<PullRequestState> {
	const json = await exec(
		`gh pr view --repo ${repo} ${prNumber} --json state,mergeStateStatus`,
	);
	return JSON.parse(json);
}

function enabledAt(pr: PullRequest): number {
	const ts = pr.autoMergeRequest?.enabledAt;
	return ts ? new Date(ts).getTime() : Number.POSITIVE_INFINITY;
}

function getPrsAhead(ours: PullRequest, all: PullRequest[]): PullRequest[] {
	const oursEnabled = enabledAt(ours);
	return all
		.filter((pr) => pr.number !== ours.number)
		.filter((pr) => enabledAt(pr) < oursEnabled)
		.sort((a, b) => enabledAt(a) - enabledAt(b));
}

type QueueOutcome =
	| { kind: "turn" }
	| { kind: "ours-merged" }
	| { kind: "ours-closed" }
	| { kind: "timeout" };

function partitionAhead(
	prsAhead: PullRequest[],
	skipped: Set<number>,
): { waiting: string[]; skippedNow: string[] } {
	const waiting: string[] = [];
	const skippedNow: string[] = [];

	for (const pr of prsAhead) {
		if (skipped.has(pr.number)) {
			skippedNow.push(`#${pr.number} (skipped)`);
			continue;
		}
		const reason = classifyAhead(pr);
		if (reason) {
			skipped.add(pr.number);
			skippedNow.push(`#${pr.number} (${formatSkipReason(reason)})`);
			continue;
		}
		waiting.push(`#${pr.number}`);
	}

	return { waiting, skippedNow };
}

async function checkOursState(
	repo: string,
	prNumber: number,
): Promise<QueueOutcome | null> {
	const oursState = await getPrState(repo, prNumber);
	if (oursState.state === "MERGED") {
		log("Our PR merged while waiting for queue - exiting early");
		return { kind: "ours-merged" };
	}
	if (oursState.state === "CLOSED") {
		log("Our PR was closed while waiting for queue");
		return { kind: "ours-closed" };
	}
	return null;
}

async function waitForPrsAhead(
	repo: string,
	ours: PullRequest,
	startTime: number,
): Promise<QueueOutcome> {
	const skipped = new Set<number>();

	while (true) {
		if (Date.now() - startTime > TIMEOUT_MS) {
			return { kind: "timeout" };
		}

		const oursOutcome = await checkOursState(repo, ours.number);
		if (oursOutcome) {
			return oursOutcome;
		}

		const allPrs = await getOpenPrsWithAutoMerge(repo);
		const prsAhead = getPrsAhead(ours, allPrs);
		const { waiting, skippedNow } = partitionAhead(prsAhead, skipped);

		if (waiting.length === 0) {
			if (skippedNow.length > 0) {
				log(`Ahead: skipping ${skippedNow.join(", ")}`);
			}
			log("No PRs ahead in queue - it's our turn!");
			return { kind: "turn" };
		}

		const parts = [`waiting on ${waiting.join(", ")}`];
		if (skippedNow.length > 0) {
			parts.push(`skipping ${skippedNow.join(", ")}`);
		}
		log(`Ahead: ${parts.join("; ")}`);

		await sleep(POLL_INTERVAL_MS);
	}
}

async function rebaseAndPush(defaultBranch: string): Promise<boolean> {
	log(`Fetching latest ${defaultBranch}...`);
	const fetchResult = await execNoThrow(`git fetch origin ${defaultBranch}`);
	if (!fetchResult.success) {
		log(`Failed to fetch: ${fetchResult.stderr}`);
		return false;
	}

	log(`Rebasing onto origin/${defaultBranch}...`);
	const rebaseResult = await execNoThrow(`git rebase origin/${defaultBranch}`);
	if (!rebaseResult.success) {
		log(`Rebase failed (conflicts?): ${rebaseResult.stderr}`);
		await execNoThrow("git rebase --abort");
		return false;
	}

	log("Force-pushing...");
	const pushResult = await execNoThrow(
		"git push --force-with-lease origin HEAD",
	);
	if (!pushResult.success) {
		log(`Push failed: ${pushResult.stderr}`);
		return false;
	}

	return true;
}

async function waitForChecksToAppear(
	repo: string,
	prNumber: number,
): Promise<boolean> {
	log("Waiting for CI checks to be registered...");

	for (let i = 0; i < CHECKS_APPEAR_MAX_ATTEMPTS; i++) {
		const result = await execNoThrow(
			`gh pr checks --repo ${repo} ${prNumber} --json name`,
		);
		if (result.success) {
			const checks: unknown[] = JSON.parse(result.stdout);
			if (checks.length > 0) {
				log(`Found ${checks.length} check(s)`);
				return true;
			}
		}
		log("No checks yet, polling...");
		await sleep(CHECKS_APPEAR_POLL_MS);
	}

	log("No checks appeared after polling");
	return false;
}

function watchChecks(repo: string, prNumber: number): Promise<boolean> {
	log("Watching CI checks...");

	return new Promise((resolve) => {
		const proc = spawn(
			"gh",
			[
				"pr",
				"checks",
				"--repo",
				repo,
				String(prNumber),
				"--watch",
				"--fail-fast",
			],
			{
				stdio: "inherit",
			},
		);

		proc.on("close", (code) => {
			if (code === 0) {
				log("All CI checks passed!");
				resolve(true);
			} else {
				log("CI checks failed");
				resolve(false);
			}
		});

		proc.on("error", (err) => {
			log(`CI check error: ${err.message}`);
			resolve(false);
		});
	});
}

async function waitForCi(repo: string, prNumber: number): Promise<boolean> {
	const hasChecks = await waitForChecksToAppear(repo, prNumber);
	if (!hasChecks) {
		return true;
	}
	return watchChecks(repo, prNumber);
}

async function waitForMerge(
	repo: string,
	prNumber: number,
	startTime: number,
): Promise<"merged" | "failed" | "timeout"> {
	log("Waiting for auto-merge to complete...");

	const mergeStart = Date.now();

	while (true) {
		if (Date.now() - startTime > TIMEOUT_MS) {
			return "timeout";
		}

		if (Date.now() - mergeStart > MERGE_WAIT_TIMEOUT_MS) {
			log("Auto-merge taking longer than expected");
			return "timeout";
		}

		const state = await getPrState(repo, prNumber);

		if (state.state === "MERGED") {
			log("PR merged successfully!");
			return "merged";
		}

		if (state.state === "CLOSED") {
			log("PR was closed without merging");
			return "failed";
		}

		if (state.mergeStateStatus === "DIRTY") {
			log("Merge conflict detected");
			return "failed";
		}

		log(`PR state: ${state.state}, merge status: ${state.mergeStateStatus}`);
		await sleep(MERGE_POLL_INTERVAL_MS);
	}
}

async function fetchDefaultBranch(defaultBranch: string): Promise<void> {
	log(`Fetching origin/${defaultBranch}...`);
	await exec(`git fetch origin ${defaultBranch}`);
	log(`Fetched origin/${defaultBranch}`);
}

function parseArgs(): {
	repo: string;
	prNumber: number;
	defaultBranch: string;
} {
	const args = process.argv.slice(2);

	if (args.length !== EXPECTED_ARGS) {
		console.error(
			"Usage: pnpx tsx ship-wait.ts <repo> <pr-number> <default-branch>",
		);
		process.exit(1);
	}

	const prNumber = Number.parseInt(args[1], 10);
	if (Number.isNaN(prNumber)) {
		console.error(`Invalid PR number: ${args[1]}`);
		process.exit(1);
	}

	return { repo: args[0], prNumber, defaultBranch: args[2] };
}

async function waitForQueueTurn(
	repo: string,
	prNumber: number,
	startTime: number,
): Promise<QueueOutcome> {
	const allPrs = await getOpenPrsWithAutoMerge(repo);
	const ourPr = allPrs.find((pr) => pr.number === prNumber);

	if (ourPr) {
		return waitForPrsAhead(repo, ourPr, startTime);
	}

	log("Warning: Our PR doesn't have auto-merge enabled, proceeding anyway");
	const json = await exec(
		`gh pr view --repo ${repo} ${prNumber} --json number,createdAt,state,headRefName`,
	);
	const pr = JSON.parse(json) as PullRequest;
	pr.autoMergeRequest = { enabledAt: new Date().toISOString() };

	return waitForPrsAhead(repo, pr, startTime);
}

async function main(): Promise<void> {
	const { repo, prNumber, defaultBranch } = parseArgs();
	const startTime = Date.now();

	log(
		`Starting ship-wait for ${repo} PR #${prNumber} (default branch: ${defaultBranch})`,
	);

	const state = await getPrState(repo, prNumber);

	if (state.state === "MERGED") {
		log("PR is already merged!");
		await fetchDefaultBranch(defaultBranch);
		process.exit(0);
	}

	if (state.state === "CLOSED") {
		log("PR is closed");
		process.exit(1);
	}

	const queueOutcome = await waitForQueueTurn(repo, prNumber, startTime);
	if (queueOutcome.kind === "ours-merged") {
		await fetchDefaultBranch(defaultBranch);
		process.exit(0);
	}
	if (queueOutcome.kind === "ours-closed") {
		process.exit(1);
	}
	if (queueOutcome.kind === "timeout") {
		log("Timeout waiting for PRs ahead");
		process.exit(2);
	}

	if (!(await rebaseAndPush(defaultBranch))) {
		log("Failed to rebase and push");
		process.exit(1);
	}

	if (!(await waitForCi(repo, prNumber))) {
		log("CI failed");
		process.exit(1);
	}

	const mergeResult = await waitForMerge(repo, prNumber, startTime);

	if (mergeResult === "merged") {
		await fetchDefaultBranch(defaultBranch);
		process.exit(0);
	} else if (mergeResult === "failed") {
		process.exit(1);
	} else {
		process.exit(2);
	}
}

process.on("SIGINT", () => {
	log("Interrupted by user");
	process.exit(1);
});

process.on("SIGTERM", () => {
	log("Terminated");
	process.exit(1);
});

main().catch((err) => {
	log(`Unexpected error: ${err.message}`);
	process.exit(1);
});
