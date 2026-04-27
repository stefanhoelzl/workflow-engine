import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import type { SqlCapture } from "../types.js";
import type { Mock } from "./types.js";

const execFileAsync = promisify(execFile);

interface PgConn {
	// Postgres connection URL (`postgres://user:pass@localhost:port/db`).
	// Loopback by design — the SQL tests need WFE_TEST_DISABLE_SSRF_PROTECTION
	// in the spawned runtime's env to bypass the net-guard.
	url: string;
	// Self-signed CA / server cert in PEM form. Tests pass this through
	// `executeSql({connection: {ssl: {ca, rejectUnauthorized: true}}})` so
	// the TLS handshake is real (cert verification, not just a tunnel).
	ca: string;
}

// Cert is generated lazily into the gitignored `.cache/` dir on first run
// and reused on subsequent runs — no commit-time secrets, but no per-run
// regeneration cost either. The cert lifetime is 100 years so the cache
// never expires in practice; if the file is missing or unreadable we
// regenerate.
const CACHE_DIR = resolve(import.meta.dirname, "..", "..", ".cache", "pg-tls");
const SERVER_CRT = join(CACHE_DIR, "server.crt");
const SERVER_KEY = join(CACHE_DIR, "server.key");

// `LOG:  statement: <sql>` — postgres's standard `log_statement=all` shape.
// We accept either a tab or spaces between the prefix and the statement.
const STATEMENT_RE = /\bLOG:\s+statement:\s+([\s\S]*)$/;

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				srv.close(() => res(addr.port));
			} else {
				srv.close(() => rej(new Error("could not allocate free port")));
			}
		});
	});
}

// Generate a self-signed cert covering both `localhost` and `127.0.0.1`
// SAN entries — the SQL plugin pins TLS SNI to the hostname the author
// passed, and node's `tls.connect` rejects an IP as ServerName, so the
// DSN must use `localhost` while postgres still binds 127.0.0.1.
async function ensureCerts(): Promise<void> {
	if (existsSync(SERVER_CRT) && existsSync(SERVER_KEY)) {
		return;
	}
	await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	await execFileAsync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		SERVER_KEY,
		"-out",
		SERVER_CRT,
		"-days",
		"36500",
		"-subj",
		"/CN=localhost",
		"-addext",
		"subjectAltName=DNS:localhost,IP:127.0.0.1",
	]);
}

// Embedded-postgres mock with TLS terminated by a self-signed cert. The
// matching CA PEM (the cert is its own CA in the self-signed case) is
// handed back so tests can pin verification end-to-end. SQL captures come
// from the cluster's `log_statement=all` output — we tail `onLog`
// (postgres writes statements to stderr by default, which
// embedded-postgres routes through `onError`, but we listen on both to
// be defensive across version upgrades).
function createPgMock(): Mock<SqlCapture, PgConn> {
	let pg: EmbeddedPostgres | null = null;
	let dataDir = "";
	let port = 0;
	const user = "wfe_e2e";
	const password = "wfe_e2e_password";
	const database = "wfe_e2e";
	return {
		name: "pg",
		async start(record): Promise<PgConn> {
			await ensureCerts();
			const ca = readFileSync(SERVER_CRT, "utf8");
			port = await freePort();
			dataDir = await mkdtemp(join(tmpdir(), "wfe-tests-pg-"));
			function recordIfStatement(line: string): void {
				const m = STATEMENT_RE.exec(line);
				if (!m) {
					return;
				}
				const statement = (m[1] ?? "").trim();
				if (statement.length === 0) {
					return;
				}
				record({ ts: Date.now(), statement });
			}
			pg = new EmbeddedPostgres({
				databaseDir: join(dataDir, "db"),
				port,
				user,
				password,
				authMethod: "password",
				persistent: false,
				postgresFlags: [
					"-c",
					"ssl=on",
					"-c",
					`ssl_cert_file=${SERVER_CRT}`,
					"-c",
					`ssl_key_file=${SERVER_KEY}`,
					"-c",
					"log_statement=all",
				],
				onLog: recordIfStatement,
				onError: (m) => {
					if (typeof m === "string") {
						recordIfStatement(m);
					}
				},
			});
			await pg.initialise();
			await pg.start();
			await pg.createDatabase(database);
			// `localhost` (not `127.0.0.1`) so the TLS handshake gets a valid
			// SNI value — node's tls.connect rejects an IP as ServerName, and
			// the SQL plugin pins `ssl.servername` to the original hostname.
			// The cert SAN covers both `DNS:localhost` and `IP:127.0.0.1`,
			// so verification succeeds either way once SNI is sane.
			const url = `postgres://${user}:${password}@localhost:${String(port)}/${database}`;
			return { url, ca };
		},
		async stop(): Promise<void> {
			if (pg) {
				try {
					await pg.stop();
				} catch {
					// embedded-postgres' stop wipes the data dir; if the cluster is
					// already torn down (test-killed parent process), swallow.
				}
				pg = null;
			}
			if (dataDir) {
				await rm(dataDir, { recursive: true, force: true });
				dataDir = "";
			}
		},
	};
}

export type { PgConn };
export { createPgMock };
