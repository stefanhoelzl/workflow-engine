import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LogLine } from "./types.js";

const READY_MSG_RE = /^Runtime listening on port (\d+)$/;
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
// We spawn through `pnpm --filter @workflow-engine/runtime dev` (vite-node)
// rather than `node packages/runtime/dist/main.js` directly. The vite-bundled
// main.js inlines the sandbox's worker.js path resolution at the wrong
// (post-bundle) `import.meta.url` location, so a freshly-built `dist/main.js`
// fails its first sandbox.run() with `Cannot find module .../dist/src/worker.js`.
// Production deployments work around this via `pnpm deploy --shamefully-hoist`
// which restructures node_modules so the unbundled sandbox dist sits beside
// the deploy root. The framework cannot easily replicate that layout per test,
// and the design's wall-clock target (<30 s) precludes running `pnpm deploy`
// per describe. vite-node is the layout the existing `pnpm dev` already
// validates daily.
const RUNTIME_DEV_ENTRY = join(
	REPO_ROOT,
	"packages",
	"runtime",
	"src",
	"main.ts",
);

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				srv.close(() => res(addr.port));
			} else {
				srv.close(() => rej(new Error("could not allocate free port")));
			}
		});
	});
}

interface SpawnOptions {
	env?: Record<string, string>;
}

interface RuntimeChild {
	readonly baseUrl: string;
	readonly persistencePath: string;
	readonly logs: readonly LogLine[];
	stop(): Promise<void>;
}

interface SpawnedChild extends RuntimeChild {
	readonly proc: ChildProcess;
}

async function spawnRuntime(opts: SpawnOptions = {}): Promise<SpawnedChild> {
	const port = await freePort();
	const persistencePath = await mkdtemp(join(tmpdir(), "wfe-tests-persist-"));
	const secretsKey = `k1:${randomBytes(32).toString("base64")}`;
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		PORT: String(port),
		PERSISTENCE_PATH: persistencePath,
		BASE_URL: `http://127.0.0.1:${String(port)}`,
		AUTH_ALLOW: "local:dev,local:alice:acme,local:bob",
		LOCAL_DEPLOYMENT: "1",
		SECRETS_PRIVATE_KEYS: secretsKey,
		LOG_LEVEL: "info",
		...(opts.env ?? {}),
	};

	const proc = spawn(
		"pnpm",
		[
			"--filter",
			"@workflow-engine/runtime",
			"exec",
			"vite-node",
			RUNTIME_DEV_ENTRY,
		],
		{
			env,
			stdio: ["ignore", "pipe", "pipe"],
			cwd: REPO_ROOT,
		},
	);

	const logs: LogLine[] = [];
	const stderrBuf: string[] = [];
	let stdoutBuffer = "";
	let stderrBuffer = "";
	let ready = false;
	let exited = false;

	let onReady: (() => void) | null = null;
	let onReadyFail: ((err: Error) => void) | null = null;

	function handleStdoutLine(line: string): void {
		if (line === "") {
			return;
		}
		try {
			const parsed = JSON.parse(line) as LogLine;
			logs.push(parsed);
			if (
				!ready &&
				typeof parsed.msg === "string" &&
				READY_MSG_RE.test(parsed.msg)
			) {
				ready = true;
				onReady?.();
			}
		} catch {
			// non-JSON line; ignore (vite/pino warnings shouldn't appear in dist build)
		}
	}

	const verbose = process.env.WFE_TESTS_VERBOSE === "1";
	proc.stdout?.on("data", (chunk: Buffer) => {
		if (verbose) {
			process.stderr.write(chunk);
		}
		stdoutBuffer += chunk.toString("utf8");
		let nl = stdoutBuffer.indexOf("\n");
		while (nl >= 0) {
			handleStdoutLine(stdoutBuffer.slice(0, nl).trimEnd());
			stdoutBuffer = stdoutBuffer.slice(nl + 1);
			nl = stdoutBuffer.indexOf("\n");
		}
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		if (verbose) {
			process.stderr.write(chunk);
		}
		stderrBuffer += chunk.toString("utf8");
		let nl = stderrBuffer.indexOf("\n");
		while (nl >= 0) {
			const line = stderrBuffer.slice(0, nl);
			stderrBuf.push(line);
			stderrBuffer = stderrBuffer.slice(nl + 1);
			nl = stderrBuffer.indexOf("\n");
		}
	});

	proc.on("exit", (code, signal) => {
		exited = true;
		if (!ready && onReadyFail) {
			const tail = stderrBuf.slice(-20).join("\n");
			onReadyFail(
				new Error(
					`runtime exited before becoming ready (code=${String(code)}, signal=${String(signal)})\nstderr tail:\n${tail}`,
				),
			);
		}
	});

	await new Promise<void>((res, rej) => {
		const timeout = setTimeout(() => {
			rej(
				new Error(
					`runtime did not emit "Runtime listening on port ..." within ${String(READY_TIMEOUT_MS)}ms\nstderr tail:\n${stderrBuf.slice(-20).join("\n")}`,
				),
			);
		}, READY_TIMEOUT_MS);
		onReady = () => {
			clearTimeout(timeout);
			res();
		};
		onReadyFail = (err) => {
			clearTimeout(timeout);
			rej(err);
		};
		if (ready) {
			clearTimeout(timeout);
			res();
		}
	});

	const baseUrl = `http://127.0.0.1:${String(port)}`;

	async function stop(): Promise<void> {
		if (exited) {
			await rm(persistencePath, { recursive: true, force: true });
			return;
		}
		const exitPromise = new Promise<void>((res) => {
			if (exited) {
				res();
				return;
			}
			proc.once("exit", () => res());
		});
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		const timeout = setTimeout(() => {
			if (!exited) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already gone
				}
			}
		}, SHUTDOWN_TIMEOUT_MS);
		await exitPromise;
		clearTimeout(timeout);
		await rm(persistencePath, { recursive: true, force: true });
	}

	return { baseUrl, persistencePath, logs, proc, stop };
}

export type { RuntimeChild, SpawnedChild };
export { spawnRuntime };
