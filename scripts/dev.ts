import { type ChildProcess, execSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";

const DEFAULT_PORT = 8080;
const DEBOUNCE_MS = 300;
const UPLOAD_MAX_ATTEMPTS = 8;
const UPLOAD_INITIAL_DELAY_MS = 100;
const KILL_WAIT_MS = 500;
const PID_PATTERN = /\d+/;

const rootDir = resolve(import.meta.dirname, "..");

function parseArgs(): { randomPort: boolean; kill: boolean } {
	return {
		randomPort: process.argv.includes("--random-port"),
		kill: process.argv.includes("--kill"),
	};
}

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				srv.close(() => resolve(addr.port));
			} else {
				srv.close(() => reject(new Error("Failed to get free port")));
			}
		});
	});
}

function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			resolve(false);
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
		await new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS));
		if (await isPortInUse(port)) {
			process.kill(Number(pid), "SIGKILL");
			await new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS));
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
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadBundle(
	port: number,
	bundlePath: string,
): Promise<boolean> {
	const body = await readFile(bundlePath);
	let delay = UPLOAD_INITIAL_DELAY_MS;

	for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(
				`http://localhost:${String(port)}/api/workflows`,
				{
					method: "POST",
					headers: { "Content-Type": "application/gzip" },
					body,
				},
			);
			if (response.ok) {
				return true;
			}
			console.error(
				`Upload failed: ${String(response.status)} ${response.statusText}`,
			);
			return false;
		} catch {
			if (attempt === UPLOAD_MAX_ATTEMPTS) {
				console.error(
					`Upload failed after ${String(UPLOAD_MAX_ATTEMPTS)} attempts (server not ready?)`,
				);
				return false;
			}
			await sleep(delay);
			delay *= 2;
		}
	}
	return false;
}

async function buildWorkflows(): Promise<void> {
	const workflowsRoot = resolve(rootDir, "workflows");
	await viteBuild({
		configFile: resolve(workflowsRoot, "vite.config.ts"),
		root: workflowsRoot,
		logLevel: "warn",
	});
}

async function uploadWorkflows(port: number): Promise<void> {
	const distDir = resolve(rootDir, "workflows/dist");
	let entries: string[];
	try {
		entries = await readdir(distDir);
	} catch {
		console.error("No workflow build output found");
		return;
	}

	for (const entry of entries) {
		const bundlePath = resolve(distDir, entry, "bundle.tar.gz");
		const ok = await uploadBundle(port, bundlePath);
		if (ok) {
			console.log(`Uploaded workflow: ${entry}`);
		}
	}
}

async function buildAndUploadWorkflows(port: number): Promise<void> {
	try {
		await buildWorkflows();
	} catch (error) {
		console.error(
			`Workflow build failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	await uploadWorkflows(port);
}

function runtimeEnv(port: number): NodeJS.ProcessEnv {
	return {
		...process.env,
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		PORT: String(port),
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		PERSISTENCE_PATH: resolve(rootDir, ".persistence"),
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		BASE_URL: `http://localhost:${String(port)}`,
	};
}

function spawnRuntime(port: number): ChildProcess {
	return spawn("pnpm", ["--filter", "@workflow-engine/runtime", "dev"], {
		stdio: "inherit",
		env: runtimeEnv(port),
	});
}

function watchWorkflows(port: number): void {
	const workflowsDir = resolve(rootDir, "workflows");
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	watch(workflowsDir, { recursive: true }, (_event, filename) => {
		if (
			!filename ||
			filename.includes("dist/") ||
			filename.startsWith("dist") ||
			!filename.endsWith(".ts") ||
			filename === "vite.config.ts"
		) {
			return;
		}

		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			console.log("Workflow source changed, rebuilding...");
			buildAndUploadWorkflows(port);
		}, DEBOUNCE_MS);
	});
}

async function main(): Promise<void> {
	const args = parseArgs();
	const port = args.randomPort ? await getFreePort() : DEFAULT_PORT;

	await ensurePortAvailable(port, args.kill);

	const runtime = spawnRuntime(port);

	console.log(`Runtime server starting on http://localhost:${String(port)}`);

	const cleanup = () => {
		if (!runtime.killed) {
			runtime.kill();
		}
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	await buildAndUploadWorkflows(port);
	watchWorkflows(port);
}

main();
