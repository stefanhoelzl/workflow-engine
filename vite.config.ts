import { type ChildProcess, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
	type Plugin,
	type ViteDevServer,
	build as viteBuild,
	defineConfig,
} from "vite";

const DEFAULT_PORT = 8080;
const DEBOUNCE_MS = 300;

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadBundle(
	port: number,
	bundlePath: string,
): Promise<boolean> {
	const body = await readFile(bundlePath);
	const maxAttempts = 8;
	let delay = 100;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			// biome-ignore lint/performance/noAwaitInLoops: sequential retry with backoff is intentional
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
			// biome-ignore lint/suspicious/noConsole: dev tool output
			console.error(
				`Upload failed: ${String(response.status)} ${response.statusText}`,
			);
			return false;
		} catch {
			if (attempt === maxAttempts) {
				// biome-ignore lint/suspicious/noConsole: dev tool output
				console.error(
					`Upload failed after ${String(maxAttempts)} attempts (server not ready?)`,
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
	const workflowsRoot = resolve(import.meta.dirname, "workflows");
	await viteBuild({
		configFile: resolve(workflowsRoot, "vite.config.ts"),
		root: workflowsRoot,
		logLevel: "warn",
	});
}

async function uploadWorkflows(port: number): Promise<void> {
	const distDir = resolve(import.meta.dirname, "workflows/dist");
	let entries: string[];
	try {
		entries = await readdir(distDir);
	} catch {
		// biome-ignore lint/suspicious/noConsole: dev tool output
		console.error("No workflow build output found");
		return;
	}

	for (const entry of entries) {
		const bundlePath = resolve(distDir, entry, "bundle.tar.gz");
		// biome-ignore lint/performance/noAwaitInLoops: sequential upload per workflow is intentional
		const ok = await uploadBundle(port, bundlePath);
		if (ok) {
			// biome-ignore lint/suspicious/noConsole: dev tool output
			console.log(`Uploaded workflow: ${entry}`);
		}
	}
}

async function buildAndUploadWorkflows(port: number): Promise<void> {
	try {
		await buildWorkflows();
	} catch (error) {
		// biome-ignore lint/suspicious/noConsole: dev tool output
		console.error(
			`Workflow build failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	await uploadWorkflows(port);
}

function spawnRuntime(port: number): ChildProcess {
	return spawn("pnpm", ["--filter", "@workflow-engine/runtime", "dev"], {
		stdio: "inherit",
		env: {
			...process.env,
			PORT: String(port),
			PERSISTENCE_PATH: resolve(import.meta.dirname, ".persistence"),
			BASE_URL: `http://localhost:${String(port)}`,
		},
	});
}

function watchWorkflows(viteServer: ViteDevServer, port: number): void {
	const workflowsDir = resolve(import.meta.dirname, "workflows");
	viteServer.watcher.add(workflowsDir);

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	const onWorkflowChange = (path: string) => {
		if (
			!path.startsWith(workflowsDir) ||
			path.includes("/dist/") ||
			!path.endsWith(".ts") ||
			path.endsWith("vite.config.ts")
		) {
			return;
		}
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			// biome-ignore lint/suspicious/noConsole: dev tool output
			console.log("Workflow source changed, rebuilding...");
			buildAndUploadWorkflows(port);
		}, DEBOUNCE_MS);
	};

	viteServer.watcher.on("change", onWorkflowChange);
	viteServer.watcher.on("add", onWorkflowChange);
}

function devServer(): Plugin {
	let server: ChildProcess | null = null;

	return {
		name: "dev-server",

		async configureServer(viteServer: ViteDevServer) {
			const randomPort = process.argv.includes("--random-port");
			const port = randomPort ? await getFreePort() : DEFAULT_PORT;

			server = spawnRuntime(port);

			// biome-ignore lint/suspicious/noConsole: dev tool output
			console.log(
				`Runtime server starting on http://localhost:${String(port)}`,
			);

			await buildAndUploadWorkflows(port);

			watchWorkflows(viteServer, port);

			viteServer.httpServer?.on("close", () => {
				if (server) {
					server.kill();
					server = null;
				}
			});
		},
	};
}

export default defineConfig({
	plugins: [devServer()],
});
