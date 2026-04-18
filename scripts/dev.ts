import { type ChildProcess, execSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { upload } from "@workflow-engine/sdk/cli";

const DEFAULT_PORT = 8080;
const DEV_TENANT = "dev";
const DEBOUNCE_MS = 300;
const PORT_POLL_INTERVAL_MS = 100;
const PORT_POLL_TIMEOUT_MS = 10_000;
const KILL_WAIT_MS = 500;
const PID_PATTERN = /\d+/;

const rootDir = resolve(import.meta.dirname, "..");
const workflowsDir = resolve(rootDir, "workflows");
const runtimeWatchDirs = [
	resolve(rootDir, "packages/runtime/src"),
	resolve(rootDir, "packages/core/src"),
	resolve(rootDir, "packages/sandbox/src"),
	resolve(rootDir, "packages/sdk/src"),
];

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

async function runUpload(port: number): Promise<void> {
	try {
		await upload({
			cwd: workflowsDir,
			url: `http://localhost:${String(port)}`,
			tenant: DEV_TENANT,
		});
	} catch (error) {
		console.error(
			`Upload failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function runtimeEnv(port: number): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(port),
		PERSISTENCE_PATH: resolve(rootDir, ".persistence"),
		BASE_URL: `http://localhost:${String(port)}`,
		GITHUB_USER: "__DISABLE_AUTH__",
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

	const restart = async () => {
		if (restarting) {
			return;
		}
		restarting = true;
		try {
			console.log("Runtime source changed, restarting...");
			const current = getRuntime();
			const exited = new Promise<void>((res) => {
				current.once("exit", () => res());
			});
			killProcessTree(current, "SIGTERM");
			await exited;
			await waitForPortFree(port, PORT_POLL_TIMEOUT_MS);
			const next = spawnRuntime(port);
			setRuntime(next);
			await waitForPort(port, PORT_POLL_TIMEOUT_MS);
			await runUpload(port);
		} catch (error) {
			console.error(
				`Runtime restart failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			restarting = false;
		}
	};

	const runtimeWatchExtensions = [".ts", ".css", ".js", ".html"];
	for (const dir of runtimeWatchDirs) {
		watch(dir, { recursive: true }, (_event, filename) => {
			if (
				!(filename && runtimeWatchExtensions.some((e) => filename.endsWith(e)))
			) {
				return;
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
