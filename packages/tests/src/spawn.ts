import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogStream, type LogStream } from "./log-stream.js";
import type { LogLine } from "./types.js";

const READY_MSG_RE = /^Runtime listening on port (\d+)$/;
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const RUNTIME_DIST_MAIN = join(
	REPO_ROOT,
	"packages",
	"runtime",
	"dist",
	"main.js",
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
	readonly logStream: LogStream;
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

	const proc = spawn("node", [RUNTIME_DIST_MAIN], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
		cwd: REPO_ROOT,
		// Dedicated process group so `process.kill(-pid, signal)` in stop()
		// reaches every descendant if node ever spawns helpers. Belt-and-braces:
		// the direct `node` child has no shell wrapper, but keeping the pgid
		// pattern means stop() stays correct under future changes.
		detached: true,
	});

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

	function killGroup(signal: NodeJS.Signals): void {
		if (proc.pid === undefined) {
			return;
		}
		try {
			// Negative pid = signal the entire process group (pgid set up by
			// `detached: true`). Reaches pnpm + sh wrapper + leaf node child
			// in one call so nothing re-parents to PID 1 and leaks.
			process.kill(-proc.pid, signal);
		} catch {
			// already gone, or pgid no longer exists; nothing to do
		}
	}

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
		killGroup("SIGTERM");
		const timeout = setTimeout(() => {
			if (!exited) {
				killGroup("SIGKILL");
			}
		}, SHUTDOWN_TIMEOUT_MS);
		await exitPromise;
		clearTimeout(timeout);
		await rm(persistencePath, { recursive: true, force: true });
	}

	const logStream = createLogStream(logs);
	return { baseUrl, persistencePath, logs, logStream, proc, stop };
}

export type { RuntimeChild, SpawnedChild };
export { spawnRuntime };
