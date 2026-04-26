// Local hoodiecrow-imap dev server. Boots an IMAPS endpoint on
// localhost:3993 with a single account `dev@localhost` / `devpass` and an
// empty INBOX. The TLS cert is self-signed and cached under
// `scripts/.dev-imap-cert/` (gitignored). Companion to `pnpm imap:send`.
//
// Invoke: `pnpm imap`. Stop with Ctrl+C / SIGTERM.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHUTDOWN_HARD_TIMEOUT_MS = 2000;

// hoodiecrow-imap is a CommonJS module without TS types — load via dynamic
// import + cast. The exported factory is `(options) => server`.
// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module without types
const hoodiecrow = (await import("hoodiecrow-imap")).default as any;

const HOST = "localhost";
const PORT = 3993;
const USER = "dev@localhost";
const PASSWORD = "devpass";

const certDir = resolve(import.meta.dirname, ".dev-imap-cert");
const keyPath = resolve(certDir, "key.pem");
const certPath = resolve(certDir, "cert.pem");

function ensureCert(): { key: Buffer; cert: Buffer } {
	if (!existsSync(certDir)) {
		mkdirSync(certDir, { recursive: true });
	}
	if (!(existsSync(keyPath) && existsSync(certPath))) {
		// Shell out to openssl. Self-signed, 10-year validity, CN=localhost.
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-days",
				"3650",
				"-subj",
				"/CN=localhost",
			],
			{ stdio: "ignore" },
		);
		// Tighten file mode on the key — defence-in-depth even though it's
		// only used for a localhost dev server.
		writeFileSync(keyPath, readFileSync(keyPath), { mode: 0o600 });
	}
	return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const { key, cert } = ensureCert();

const server = hoodiecrow({
	plugins: ["STARTTLS", "UIDPLUS", "MOVE", "IDLE", "LITERALPLUS"],
	secureConnection: true,
	port: PORT,
	credentials: { key, cert },
	storage: {
		INBOX: { messages: [] },
	},
	users: {
		[USER]: { password: PASSWORD },
	},
});

server.server.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		const pid = findPidOnPort(PORT);
		const where = pid === undefined ? "another process" : `PID ${pid}`;
		console.error(`Port ${String(PORT)} is already in use by ${where}.`);
		console.error(
			"Run `pnpm imap:kill` to stop it, or kill the process directly.",
		);
		process.exit(1);
	}
	console.error(`IMAP server error: ${err.message}`);
	process.exit(1);
});

server.listen(PORT, () => {
	console.log(`IMAP server listening on imaps://${HOST}:${String(PORT)}`);
	console.log(`  user: ${USER}`);
	console.log(`  pass: ${PASSWORD}`);
});

function findPidOnPort(port: number): string | undefined {
	const probes = [
		`fuser ${String(port)}/tcp 2>/dev/null`,
		`lsof -ti:${String(port)} 2>/dev/null`,
	];
	for (const cmd of probes) {
		try {
			const out = execFileSync("sh", ["-c", cmd], {
				encoding: "utf-8",
			}).trim();
			const m = out.match(/\d+/);
			if (m) {
				return m[0];
			}
		} catch {
			// command not present or no match — try next probe.
		}
	}
	return;
}

function shutdown(signal: NodeJS.Signals): void {
	console.log(`Received ${signal}, shutting down IMAP server...`);
	try {
		server.server.close(() => {
			process.exit(0);
		});
	} catch {
		process.exit(0);
	}
	// Hard exit if close hangs.
	setTimeout(() => process.exit(0), SHUTDOWN_HARD_TIMEOUT_MS).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
