import { type ChildProcess, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { upload } from "@workflow-engine/sdk/cli";

const DEFAULT_PORT = 8080;
const DEV_OWNER = "local";
// Two upload targets under the same owner so the dashboard drill-down,
// cross-repo workflow-name collision, and trigger-backend per-(owner, repo)
// reconfigure paths all exercise on every `pnpm start`.
const DEV_REPOS = ["demo", "demo-advanced"] as const;
const DEBOUNCE_MS = 300;
const PORT_POLL_INTERVAL_MS = 100;
const PORT_POLL_TIMEOUT_MS = 10_000;
const KILL_WAIT_MS = 500;
const PID_PATTERN = /\d+/;

const rootDir = resolve(import.meta.dirname, "..");
const workflowsDir = resolve(rootDir, "workflows");
const sandboxSrcDir = resolve(rootDir, "packages/sandbox/src");
const runtimeWatchDirs = [
	resolve(rootDir, "packages/runtime/src"),
	resolve(rootDir, "packages/core/src"),
	sandboxSrcDir,
	resolve(rootDir, "packages/sandbox-stdlib/src"),
	resolve(rootDir, "packages/sdk/src"),
];

function buildSandbox(): void {
	execSync("pnpm --filter @workflow-engine/sandbox build", {
		stdio: "inherit",
		cwd: rootDir,
	});
}

function parseArgs(): { randomPort: boolean; kill: boolean } {
	return {
		randomPort: process.argv.includes("--random-port"),
		kill: process.argv.includes("--kill"),
	};
}

function getFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				srv.close(() => res(addr.port));
			} else {
				srv.close(() => rej(new Error("Failed to get free port")));
			}
		});
	});
}

function isPortInUse(port: number): Promise<boolean> {
	return new Promise((res) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			res(true);
		});
		socket.once("error", () => {
			res(false);
		});
	});
}

function findPidOnPort(port: number): string | undefined {
	const commands = [
		`fuser ${String(port)}/tcp 2>/dev/null`,
		`lsof -ti:${String(port)} 2>/dev/null`,
		`ss -tlnp sport = :${String(port)} 2>/dev/null`,
	];
	for (const cmd of commands) {
		try {
			const output = execSync(cmd, { encoding: "utf-8" }).trim();
			if (output) {
				const match = PID_PATTERN.exec(output);
				if (match) {
					return match[0];
				}
			}
		} catch {
			// command not available or failed, try next
		}
	}
	return;
}

async function ensurePortAvailable(port: number, kill: boolean): Promise<void> {
	if (!(await isPortInUse(port))) {
		return;
	}

	const pid = findPidOnPort(port);
	const pidInfo = pid ? ` (PID: ${pid})` : "";

	if (kill && pid) {
		console.log(`Killing process ${pid} on port ${String(port)}...`);
		process.kill(Number(pid), "SIGTERM");
		await new Promise((res) => setTimeout(res, KILL_WAIT_MS));
		if (await isPortInUse(port)) {
			process.kill(Number(pid), "SIGKILL");
			await new Promise((res) => setTimeout(res, KILL_WAIT_MS));
		}
		if (await isPortInUse(port)) {
			console.error(
				`Failed to free port ${String(port)} after killing process ${pid}`,
			);
			process.exit(1);
		}
		return;
	}

	console.error(
		`Port ${String(port)} is already in use${pidInfo}. Use --kill to terminate the blocking process.`,
	);
	process.exit(1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isPortInUse(port)) {
			return;
		}
		await sleep(PORT_POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out after ${String(timeoutMs)}ms waiting for port ${String(port)}`,
	);
}

// Dev defaults for every `env({ secret: true })` binding in the in-repo demo
// workflow. The SDK CLI reads `process.env[name]` when sealing — if the
// operator hasn't set one explicitly, fall back to a placeholder so
// `pnpm dev` works end-to-end without requiring a shell-side export.
// Operator overrides (e.g. `WEBHOOK_TOKEN=real-value pnpm dev`) take
// precedence because the existing value is preserved.
const DEV_SECRET_DEFAULTS: Record<string, string> = {
	WEBHOOK_TOKEN: "dev-webhook-token",
	IMAP_USER: "dev@localhost",
	IMAP_PASSWORD: "devpass",
};
for (const [envName, fallback] of Object.entries(DEV_SECRET_DEFAULTS)) {
	process.env[envName] ??= fallback;
}

async function runUpload(port: number): Promise<void> {
	for (const repo of DEV_REPOS) {
		try {
			await upload({
				cwd: workflowsDir,
				url: `http://localhost:${String(port)}`,
				owner: DEV_OWNER,
				repo,
				user: DEV_OWNER,
			});
		} catch (error) {
			console.error(
				`Upload failed (${DEV_OWNER}/${repo}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

// Dev-only X25519 keypair: 32 random bytes generated once per dev-server
// lifetime, CSV-formatted as `k1:<b64>` for SECRETS_PRIVATE_KEYS. A fresh
// key is minted on every `pnpm dev` invocation; any previously sealed
// tenant bundles would fail upload decrypt-verify, which is fine in dev
// because workflows are re-uploaded by this script on source change.
const DEV_SECRETS_PRIVATE_KEYS = `k1:${randomBytes(32).toString("base64")}`;

function runtimeEnv(port: number): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(port),
		PERSISTENCE_PATH: resolve(rootDir, ".persistence"),
		BASE_URL: `http://localhost:${String(port)}`,
		AUTH_ALLOW: "local:local,local:alice:acme,local:bob",
		LOCAL_DEPLOYMENT: "1",
		SECRETS_PRIVATE_KEYS: DEV_SECRETS_PRIVATE_KEYS,
	};
}

function spawnRuntime(port: number): ChildProcess {
	return spawn("pnpm", ["--filter", "@workflow-engine/runtime", "dev"], {
		stdio: "inherit",
		env: runtimeEnv(port),
		detached: true,
	});
}

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (proc.killed || proc.pid === undefined) {
		return;
	}
	try {
		process.kill(-proc.pid, signal);
	} catch {
		if (!proc.killed) {
			proc.kill(signal);
		}
	}
}

function watchWorkflows(port: number): void {
	const srcDir = resolve(workflowsDir, "src");
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	watch(srcDir, { recursive: true }, (_event, filename) => {
		if (!filename?.endsWith(".ts")) {
			return;
		}

		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			console.log("Workflow source changed, rebuilding...");
			runUpload(port);
		}, DEBOUNCE_MS);
	});
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!(await isPortInUse(port))) {
			return;
		}
		await sleep(PORT_POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out after ${String(timeoutMs)}ms waiting for port ${String(port)} to free`,
	);
}

function watchRuntime(
	port: number,
	getRuntime: () => ChildProcess,
	setRuntime: (proc: ChildProcess) => void,
): void {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let restarting = false;
	let pendingRestart = false;
	let sandboxDirty = false;

	const restart = async () => {
		if (restarting) {
			// Another edit arrived while we're still restarting. Remember to
			// run one more cycle after this one finishes; otherwise the edit
			// would be silently dropped because the debounce timer has
			// already fired.
			pendingRestart = true;
			return;
		}
		restarting = true;
		try {
			do {
				pendingRestart = false;
				console.log("Runtime source changed, restarting...");
				const current = getRuntime();
				const exited = new Promise<void>((res) => {
					current.once("exit", () => res());
				});
				killProcessTree(current, "SIGTERM");
				await exited;
				await waitForPortFree(port, PORT_POLL_TIMEOUT_MS);
				if (sandboxDirty) {
					sandboxDirty = false;
					console.log("Rebuilding sandbox worker...");
					buildSandbox();
				}
				const next = spawnRuntime(port);
				setRuntime(next);
				await waitForPort(port, PORT_POLL_TIMEOUT_MS);
				await runUpload(port);
			} while (pendingRestart);
		} catch (error) {
			console.error(
				`Runtime restart failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			restarting = false;
		}
	};

	// The watched dirs are `packages/*/src` — source trees only, no build
	// output or editor detritus — so every event is a real code change
	// and no per-filename filter is needed. This also sidesteps a libuv
	// recursive-watch quirk on Linux where, after an atomic-rename replace
	// (the pattern Claude Code's Edit tool and many other editors use),
	// libuv loses the per-file watch on the target and only surfaces
	// events on the intermediate `.tmp.<pid>.<ts>` name; accepting every
	// event keeps us in sync regardless.
	for (const dir of runtimeWatchDirs) {
		const isSandboxDir = dir === sandboxSrcDir;
		watch(dir, { recursive: true }, () => {
			if (isSandboxDir) {
				sandboxDirty = true;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(restart, DEBOUNCE_MS);
		});
	}
}

async function main(): Promise<void> {
	const args = parseArgs();
	const port = args.randomPort ? await getFreePort() : DEFAULT_PORT;

	await ensurePortAvailable(port, args.kill);

	console.log("Building sandbox worker...");
	buildSandbox();

	let runtime = spawnRuntime(port);

	console.log(`Runtime server starting on http://localhost:${String(port)}`);

	const cleanup = () => {
		killProcessTree(runtime, "SIGTERM");
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	try {
		await waitForPort(port, PORT_POLL_TIMEOUT_MS);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		cleanup();
		process.exit(1);
	}

	await runUpload(port);
	console.log(`Dev ready on http://localhost:${String(port)} (tenant=dev)`);
	watchWorkflows(port);
	watchRuntime(
		port,
		() => runtime,
		(next) => {
			runtime = next;
		},
	);
}

main();
