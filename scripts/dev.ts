import { type ChildProcess, execSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { build as viteBuild } from "vite";

const DEFAULT_PORT = 8080;
const DEBOUNCE_MS = 300;
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

async function buildWorkflows(): Promise<void> {
	const workflowsRoot = resolve(rootDir, "workflows");
	await viteBuild({
		configFile: resolve(workflowsRoot, "vite.config.ts"),
		root: workflowsRoot,
		logLevel: "warn",
	});
}

function runtimeEnv(port: number): NodeJS.ProcessEnv {
	// Note: WORKFLOWS_DIR is intentionally NOT set. The runtime boots with
	// an empty registry and we upload each built workflow via
	// POST /api/workflows once the runtime is reachable — mirroring the
	// production flow (workflows arrive via upload, not via a shared
	// filesystem mount).
	return {
		...process.env,
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		PORT: String(port),
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		PERSISTENCE_PATH: resolve(rootDir, ".persistence"),
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		BASE_URL: `http://localhost:${String(port)}`,
		// biome-ignore lint/style/useNamingConvention: environment variables are UPPER_CASE by convention
		GITHUB_USER: "__DISABLE_AUTH__",
	};
}

const UPLOAD_POLL_INTERVAL_MS = 250;
const UPLOAD_POLL_TIMEOUT_MS = 15_000;

async function waitForRuntime(port: number): Promise<void> {
	const deadline = Date.now() + UPLOAD_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isPortInUse(port)) {
			return;
		}
		await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS));
	}
	throw new Error(`runtime did not bind to ${String(port)} in time`);
}

async function uploadWorkflow(
	port: number,
	distRoot: string,
	entry: string,
): Promise<void> {
	const tarGzPath = join(distRoot, entry, "bundle.tar.gz");
	const s = await stat(tarGzPath).catch(() => undefined);
	if (!s?.isFile()) {
		return;
	}
	const body = await readFile(tarGzPath);
	const res = await fetch(`http://localhost:${String(port)}/api/workflows`, {
		method: "POST",
		body: new Uint8Array(body),
	});
	if (!res.ok) {
		const text = await res.text();
		console.error(`Upload of "${entry}" failed: ${String(res.status)} ${text}`);
		return;
	}
	console.log(`Uploaded workflow "${entry}"`);
}

async function uploadWorkflows(port: number): Promise<void> {
	const distRoot = resolve(rootDir, "workflows/dist");
	let entries: string[];
	try {
		entries = await readdir(distRoot);
	} catch {
		console.warn(`No workflows built at ${distRoot}; skipping upload.`);
		return;
	}
	await Promise.all(
		entries.map((entry) => uploadWorkflow(port, distRoot, entry)),
	);
}

function spawnRuntime(port: number): ChildProcess {
	return spawn("pnpm", ["--filter", "@workflow-engine/runtime", "dev"], {
		stdio: "inherit",
		env: runtimeEnv(port),
	});
}

function watchWorkflows(restart: () => void): void {
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
			console.log(
				"Workflow source changed, rebuilding + restarting runtime...",
			);
			(async () => {
				try {
					await buildWorkflows();
				} catch (error) {
					console.error(
						`Workflow build failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
				restart();
			})();
		}, DEBOUNCE_MS);
	});
}

async function main(): Promise<void> {
	const args = parseArgs();
	const port = args.randomPort ? await getFreePort() : DEFAULT_PORT;

	await ensurePortAvailable(port, args.kill);

	try {
		await buildWorkflows();
	} catch (error) {
		console.error(
			`Initial workflow build failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	let runtime = spawnRuntime(port);

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

	try {
		await waitForRuntime(port);
		await uploadWorkflows(port);
	} catch (error) {
		console.error(
			`Post-boot upload failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	watchWorkflows(() => {
		cleanup();
		runtime = spawnRuntime(port);
		waitForRuntime(port)
			.then(() => uploadWorkflows(port))
			.catch((error: unknown) => {
				console.error(
					`Post-restart upload failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	});
}

main();
