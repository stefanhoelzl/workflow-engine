import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { type Plugin, build as viteBuild, defineConfig } from "vite";

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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Vite plugin lifecycle hooks in single closure
function devServer(): Plugin {
	let server: ChildProcess | null = null;
	let enabled = false;
	let port: number;

	return {
		name: "dev-server",
		apply: "build",
		config(userConfig) {
			if (userConfig.build?.watch) {
				// Output into packages/runtime/dist so Node ESM resolution
				// finds runtime dependencies (e.g. @duckdb/node-api) via
				// packages/runtime/node_modules. NODE_PATH is not supported
				// for ESM imports.
				return { build: { outDir: "packages/runtime/dist" } };
			}
		},
		configResolved(config) {
			enabled = Boolean(config.build.watch);
		},
		buildStart() {
			if (!enabled) {
				return;
			}
			const watchDirs = ["workflows", "packages/sdk/src"];
			for (const dir of watchDirs) {
				const abs = resolve(import.meta.dirname, dir);
				for (const file of readdirSync(abs, { recursive: true })) {
					if (file.toString().endsWith(".ts") && !file.toString().includes("config")) {
						this.addWatchFile(resolve(abs, file.toString()));
					}
				}
			}
		},
		async closeBundle() {
			if (!enabled) {
				return;
			}
			if (!port) {
				port = await getFreePort();
			}
			try {
				await viteBuild({
					configFile: resolve(import.meta.dirname, "workflows/vite.config.ts"),
					root: resolve(import.meta.dirname, "workflows"),
				});
			} catch (error) {
				// biome-ignore lint/suspicious/noConsole: surface workflow build errors clearly
				console.error(`Workflow build failed: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			if (server) {
				server.kill();
				// biome-ignore lint/style/noNonNullAssertion: narrowed by if-check above
				await new Promise<void>((r) => server!.on("exit", r));
			}
			server = spawn(process.execPath, [resolve(import.meta.dirname, "packages/runtime/dist/main.js")], {
				stdio: "inherit",
				env: {
					...process.env,
					WORKFLOW_DIR: resolve(import.meta.dirname, "workflows/dist"),
					PERSISTENCE_PATH: resolve(import.meta.dirname, ".persistence"),
					PORT: String(port),
					BASE_URL: `http://localhost:${port}`,
				},
			});
			// biome-ignore lint/suspicious/noConsole: intentional startup message
			console.log(`Server listening on http://localhost:${port}`);
		},
	};
}

export default defineConfig({
	build: {
		ssr: "packages/runtime/src/main.ts",
		outDir: "dist",
	},
	ssr: {
		target: "node",
		noExternal: true,
		external: ["@duckdb/node-bindings", "@jitl/quickjs-wasmfile-release-sync"],
	},
	plugins: [devServer()],
});
