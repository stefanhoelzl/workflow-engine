import { createRequire } from "node:module";
import { createServer } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImapTriggerDescriptor, InvokeResult } from "../executor/types.js";
import type { Logger } from "../logger.js";
import { createImapTriggerSource } from "./imap.js";
import type { TriggerEntry } from "./source.js";

// ---------------------------------------------------------------------------
// Integration tests for createImapTriggerSource against a live hoodiecrow IMAP
// server. Each test boots its own hoodiecrow on a random free port (plain TCP,
// `tls: "none"` on the descriptor side) so cert generation is not required.
//
// Drive a single poll by calling `reconfigure(...)` (which arms the first
// timer at delay 0) and waiting for the handler mock to settle. The default
// 60s re-arm is canceled by `source.stop()` in `afterEach`.
// ---------------------------------------------------------------------------

// hoodiecrow-imap is a CommonJS module without TypeScript types. Use
// `createRequire` to side-step the verbatimModuleSyntax + NodeNext interop
// constraint without polluting the source tree with ambient declarations.
const require_ = createRequire(import.meta.url);
interface HoodiecrowServer {
	listen(port: number, cb?: () => void): void;
	close(cb?: (err?: Error) => void): void;
}
const hoodiecrow = require_("hoodiecrow-imap") as (
	options: Record<string, unknown>,
) => HoodiecrowServer;

type LogFn = (msg: string, data?: Record<string, unknown>) => void;

interface FakeLogger extends Logger {
	readonly warn: LogFn & ReturnType<typeof vi.fn>;
	readonly error: LogFn & ReturnType<typeof vi.fn>;
	readonly info: LogFn & ReturnType<typeof vi.fn>;
	readonly debug: LogFn & ReturnType<typeof vi.fn>;
	readonly trace: LogFn & ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLogger {
	const wrap = () => vi.fn() as unknown as LogFn & ReturnType<typeof vi.fn>;
	const logger: FakeLogger = {
		warn: wrap(),
		error: wrap(),
		info: wrap(),
		debug: wrap(),
		trace: wrap(),
		child: () => logger,
	};
	return logger;
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr === null || typeof addr === "string") {
				srv.close();
				reject(new Error("no address"));
				return;
			}
			const port = addr.port;
			srv.close(() => {
				resolve(port);
			});
		});
	});
}

interface ServerHandle {
	readonly port: number;
	close(): Promise<void>;
}

async function startHoodiecrow(opts?: {
	extraFolders?: readonly string[];
}): Promise<ServerHandle> {
	const port = await freePort();
	const storage: Record<string, unknown> = {
		INBOX: { messages: [] as unknown[] },
		"": { separator: "/", folders: {} as Record<string, unknown> },
	};
	if (opts?.extraFolders) {
		const folders = (storage[""] as { folders: Record<string, unknown> })
			.folders;
		for (const f of opts.extraFolders) {
			folders[f] = { messages: [] as unknown[] };
		}
	}
	const server = hoodiecrow({
		plugins: ["UIDPLUS", "MOVE", "IDLE", "LITERALPLUS"],
		users: { dev: { password: "devpass" } },
		storage,
	});
	await new Promise<void>((resolve) => {
		server.listen(port, () => {
			resolve();
		});
	});
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			}),
	};
}

function makeDescriptor(
	overrides: Partial<ImapTriggerDescriptor> & { port: number },
): ImapTriggerDescriptor {
	const { port, ...rest } = overrides;
	return {
		kind: "imap",
		type: "imap",
		name: "inbound",
		workflowName: "w",
		host: "127.0.0.1",
		tls: "none",
		insecureSkipVerify: false,
		user: "dev",
		password: "devpass",
		folder: "INBOX",
		search: "ALL",
		onError: {},
		inputSchema: {},
		outputSchema: {},
		...rest,
		port,
	};
}

interface RecordedEntry {
	entry: TriggerEntry<ImapTriggerDescriptor>;
	fire: ReturnType<typeof vi.fn>;
	exception: ReturnType<typeof vi.fn>;
}

function makeEntry(
	descriptor: ImapTriggerDescriptor,
	fireImpl: (input: unknown) => Promise<InvokeResult<unknown>>,
): RecordedEntry {
	const fire = vi.fn(fireImpl);
	const exception = vi.fn(async () => undefined);
	const entry: TriggerEntry<ImapTriggerDescriptor> = {
		descriptor,
		fire,
		exception,
	};
	return { entry, fire, exception };
}

async function waitForExceptionCount(
	exception: ReturnType<typeof vi.fn>,
	count: number,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (exception.mock.calls.length < count) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`timeout: exception called ${exception.mock.calls.length}/${count}`,
			);
		}
		// biome-ignore lint/performance/noAwaitInLoops: poll loop — sequential by intent
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function withClient<T>(
	port: number,
	fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
	const client = new ImapFlow({
		host: "127.0.0.1",
		port,
		secure: false,
		auth: { user: "dev", pass: "devpass" },
		logger: false,
		emitLogs: false,
	});
	await client.connect();
	try {
		return await fn(client);
	} finally {
		try {
			await client.logout();
		} catch {
			// best effort
		}
	}
}

async function appendMessage(
	port: number,
	folder: string,
	subject: string,
	body = "hello",
): Promise<void> {
	const raw = `From: sender@example.com\r\nTo: dev@example.com\r\nSubject: ${subject}\r\nMessage-Id: <${subject}@x>\r\nDate: Fri, 13 Sep 2013 15:01:00 +0300\r\n\r\n${body}`;
	await withClient(port, async (c) => {
		await c.append(folder, raw);
	});
}

async function waitForFireCount(
	fire: ReturnType<typeof vi.fn>,
	count: number,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (fire.mock.calls.length < count) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`timeout: fire called ${fire.mock.calls.length}/${count}`,
			);
		}
		// biome-ignore lint/performance/noAwaitInLoops: poll loop — sequential by intent
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function waitForLog(
	logger: FakeLogger,
	level: "warn" | "error",
	predicate: (
		msg: string,
		data: Record<string, unknown> | undefined,
	) => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (
		!logger[level].mock.calls.some(
			(c: unknown[]) =>
				typeof c[0] === "string" &&
				predicate(c[0], c[1] as Record<string, unknown> | undefined),
		)
	) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timeout waiting for ${level} log`);
		}
		// biome-ignore lint/performance/noAwaitInLoops: poll loop — sequential by intent
		await new Promise((r) => setTimeout(r, 10));
	}
}

const TEST_TIMEOUT_MS = 30_000;

describe("createImapTriggerSource (hoodiecrow integration)", {
	timeout: TEST_TIMEOUT_MS,
}, () => {
	let server: ServerHandle;

	beforeEach(async () => {
		server = await startHoodiecrow({ extraFolders: ["Archive"] });
	});

	afterEach(async () => {
		await server.close();
	});

	it("7.1 fires handler with parsed message and applies +FLAGS Seen disposition", async () => {
		await appendMessage(server.port, "INBOX", "probe1");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "UNSEEN" });
		const rec = makeEntry(desc, async (input) => {
			const msg = input as { uid: number; subject: string };
			return {
				ok: true,
				output: { command: [`UID STORE ${msg.uid} +FLAGS (\\Seen)`] },
			};
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		await source.stop();

		const arg = rec.fire.mock.calls[0]?.[0] as {
			subject: string;
			uid: number;
			from: { address: string };
		};
		expect(arg.subject).toBe("probe1");
		expect(arg.uid).toBe(1);
		expect(arg.from.address).toBe("sender@example.com");

		// Verify \Seen is set.
		await withClient(server.port, async (c) => {
			await c.mailboxOpen("INBOX");
			const fetched = await c.fetchOne("1", { flags: true }, { uid: true });
			expect(fetched).not.toBe(false);
			if (fetched !== false && fetched.flags) {
				expect([...fetched.flags]).toContain("\\Seen");
			}
		});
	});

	it("7.2 +FLAGS (\\Seen) disposition reflected in subsequent UNSEEN search", async () => {
		await appendMessage(server.port, "INBOX", "probe2");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "UNSEEN" });
		const rec = makeEntry(desc, async (input) => {
			const msg = input as { uid: number };
			return {
				ok: true,
				output: { command: [`UID STORE ${msg.uid} +FLAGS (\\Seen)`] },
			};
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		// Second poll: re-arm via reconfigure with same entry.
		await source.reconfigure("o", "r", [rec.entry]);
		// Give second poll time to run; expect handler NOT called again because
		// UNSEEN no longer matches.
		await new Promise((r) => setTimeout(r, 300));
		await source.stop();

		expect(rec.fire).toHaveBeenCalledTimes(1);
	});

	it("7.3 custom keyword +FLAGS (processed) is set on the message", async () => {
		await appendMessage(server.port, "INBOX", "probe3");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "ALL" });
		const rec = makeEntry(desc, async (input) => {
			const msg = input as { uid: number };
			return {
				ok: true,
				output: { command: [`UID STORE ${msg.uid} +FLAGS (processed)`] },
			};
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		await source.stop();

		await withClient(server.port, async (c) => {
			await c.mailboxOpen("INBOX");
			const fetched = await c.fetchOne("1", { flags: true }, { uid: true });
			expect(fetched).not.toBe(false);
			if (fetched !== false && fetched.flags) {
				expect([...fetched.flags]).toContain("processed");
			}
		});
	});

	it("7.4 UID MOVE Archive removes message from INBOX and creates it in Archive", async () => {
		await appendMessage(server.port, "INBOX", "probe4");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "ALL" });
		const rec = makeEntry(desc, async (input) => {
			const msg = input as { uid: number };
			return {
				ok: true,
				output: { command: [`UID MOVE ${msg.uid} Archive`] },
			};
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		// Allow disposition to complete on the server.
		await new Promise((r) => setTimeout(r, 100));
		await source.stop();

		await withClient(server.port, async (c) => {
			const inbox = await c.mailboxOpen("INBOX");
			expect(inbox.exists).toBe(0);
			const archive = await c.mailboxOpen("Archive");
			expect(archive.exists).toBe(1);
		});
	});

	it("7.5 +FLAGS (\\Deleted) followed by UID EXPUNGE removes message", async () => {
		await appendMessage(server.port, "INBOX", "probe5");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "ALL" });
		const rec = makeEntry(desc, async (input) => {
			const msg = input as { uid: number };
			return {
				ok: true,
				output: {
					command: [
						`UID STORE ${msg.uid} +FLAGS (\\Deleted)`,
						`UID EXPUNGE ${msg.uid}`,
					],
				},
			};
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		await new Promise((r) => setTimeout(r, 100));
		await source.stop();

		await withClient(server.port, async (c) => {
			const inbox = await c.mailboxOpen("INBOX");
			expect(inbox.exists).toBe(0);
		});
	});

	it("7.6 handler throws + onError command applied; subsequent poll does not re-match", async () => {
		await appendMessage(server.port, "INBOX", "probe6");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({
			port: server.port,
			search: "UNSEEN",
			onError: { command: ["UID STORE 1 +FLAGS (\\Seen)"] },
		});
		const rec = makeEntry(desc, async () => {
			throw new Error("boom");
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		// Wait for disposition to land + log to flush.
		await waitForLog(logger, "error", (m) => m === "imap.fire-threw");
		// Re-arm via reconfigure: second poll.
		await source.reconfigure("o", "r", [rec.entry]);
		await new Promise((r) => setTimeout(r, 300));
		await source.stop();

		expect(rec.fire).toHaveBeenCalledTimes(1);
		// Confirm \Seen was applied via onError.
		await withClient(server.port, async (c) => {
			await c.mailboxOpen("INBOX");
			const fetched = await c.fetchOne("1", { flags: true }, { uid: true });
			expect(fetched).not.toBe(false);
			if (fetched !== false && fetched.flags) {
				expect([...fetched.flags]).toContain("\\Seen");
			}
		});
	});

	it("7.7 handler throws + empty onError; subsequent poll re-fires same UID", async () => {
		await appendMessage(server.port, "INBOX", "probe7");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({
			port: server.port,
			search: "ALL",
			onError: {},
		});
		const rec = makeEntry(desc, async () => {
			throw new Error("boom");
		});

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		// Re-arm second poll.
		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 2);
		await source.stop();

		expect(rec.fire.mock.calls.length).toBeGreaterThanOrEqual(2);
		const uid1 = (rec.fire.mock.calls[0]?.[0] as { uid: number }).uid;
		const uid2 = (rec.fire.mock.calls[1]?.[0] as { uid: number }).uid;
		expect(uid1).toBe(uid2);
	});

	it("7.8 bad credentials emit trigger.exception without leaking user/password", async () => {
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({
			port: server.port,
			user: "dev",
			password: "WRONG_SECRET",
		});
		const rec = makeEntry(desc, async () => ({ ok: true, output: {} }));

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForExceptionCount(rec.exception, 1);
		await source.stop();

		const params = rec.exception.mock.calls[0]?.[0] as {
			name: string;
			error: { message: string };
			details: { stage: string; failedUids: number[] };
		};
		expect(params.name).toBe("imap.poll-failed");
		expect(params.details.stage).toBe("connect");
		expect(params.details.failedUids).toEqual([]);
		// Credentials must never appear in the emitted payload.
		const blob = JSON.stringify(params);
		expect(blob).not.toContain("WRONG_SECRET");
		// imap.connect-failed Pino log is REMOVED — assert silence.
		const connectLogs = logger.warn.mock.calls.filter(
			(c: unknown[]) => c[0] === "imap.connect-failed",
		);
		expect(connectLogs).toHaveLength(0);
		expect(rec.fire).not.toHaveBeenCalled();
	});

	it("7.9 failing disposition emits trigger.exception(stage=disposition) and stops batch", async () => {
		await appendMessage(server.port, "INBOX", "msgA");
		await appendMessage(server.port, "INBOX", "msgB");
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "ALL" });
		// Use an unknown IMAP verb so the disposition's raw-exec fallback path
		// receives a `BAD` from the server.
		const rec = makeEntry(desc, async () => ({
			ok: true,
			output: { command: ["BOGUSVERB"] },
		}));

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 1);
		await waitForExceptionCount(rec.exception, 1);
		await source.stop();

		const params = rec.exception.mock.calls[0]?.[0] as {
			name: string;
			details: { stage: string; failedUids: number[] };
		};
		expect(params.name).toBe("imap.poll-failed");
		expect(params.details.stage).toBe("disposition");
		expect(params.details.failedUids).toHaveLength(1);
		// Batch stopped after first failure.
		expect(rec.fire).toHaveBeenCalledTimes(1);
		// imap.disposition-failed Pino log is REMOVED.
		const dispLogs = logger.warn.mock.calls.filter(
			(c: unknown[]) => c[0] === "imap.disposition-failed",
		);
		expect(dispLogs).toHaveLength(0);
	});

	it("7.10 next poll's batch is serial — fires sequenced, no overlap", async () => {
		await appendMessage(server.port, "INBOX", "m1");
		await appendMessage(server.port, "INBOX", "m2");
		await appendMessage(server.port, "INBOX", "m3");

		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "ALL" });

		const fireTimestamps: number[] = [];
		let inFlight = 0;
		let maxConcurrent = 0;
		const rec = makeEntry(desc, async (input) => {
			fireTimestamps.push(Date.now());
			inFlight += 1;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			await new Promise((r) => setTimeout(r, 100));
			inFlight -= 1;
			const msg = input as { uid: number };
			return {
				ok: true,
				output: { command: [`UID STORE ${msg.uid} +FLAGS (\\Seen)`] },
			};
		});

		const start = Date.now();
		await source.reconfigure("o", "r", [rec.entry]);
		await waitForFireCount(rec.fire, 3, 10_000);
		await source.stop();

		expect(maxConcurrent).toBe(1);
		// At least 100ms between successive fires (handler delay).
		const gap1 = (fireTimestamps[1] ?? 0) - (fireTimestamps[0] ?? 0);
		const gap2 = (fireTimestamps[2] ?? 0) - (fireTimestamps[1] ?? 0);
		const SOFT_GAP_MS = 80;
		expect(gap1).toBeGreaterThanOrEqual(SOFT_GAP_MS);
		expect(gap2).toBeGreaterThanOrEqual(SOFT_GAP_MS);
		// Total elapsed at least 3 * 100ms.
		expect(Date.now() - start).toBeGreaterThanOrEqual(300);
	});

	it("7.12 connect refused emits one trigger.exception(stage=connect)", async () => {
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		// Deliberately wrong port — TCP RST.
		const refusedPort = await freePort();
		const desc = makeDescriptor({ port: refusedPort });
		const rec = makeEntry(desc, async () => ({ ok: true, output: {} }));

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForExceptionCount(rec.exception, 1);
		await source.stop();

		expect(rec.exception).toHaveBeenCalledTimes(1);
		const params = rec.exception.mock.calls[0]?.[0] as {
			name: string;
			error: { message: string };
			details: { stage: string; failedUids: number[] };
		};
		expect(params.name).toBe("imap.poll-failed");
		expect(params.details.stage).toBe("connect");
		expect(params.details.failedUids).toEqual([]);
		// Classification embedded in error.message text, not as a separate field.
		expect(params.error.message).toMatch(
			/connect-failed|tls-failed|auth-failed/,
		);
		expect(rec.fire).not.toHaveBeenCalled();
		// No Pino warn for connect/search/fetch/disposition stages.
		const warnNames = logger.warn.mock.calls.map((c: unknown[]) => c[0]);
		expect(warnNames).not.toContain("imap.connect-failed");
	});

	it("7.13 search rejected emits one trigger.exception(stage=search)", async () => {
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		// Hoodiecrow rejects unknown SEARCH keywords with BAD.
		const desc = makeDescriptor({
			port: server.port,
			search: "BOGUSKEYWORD",
		});
		const rec = makeEntry(desc, async () => ({ ok: true, output: {} }));

		await source.reconfigure("o", "r", [rec.entry]);
		await waitForExceptionCount(rec.exception, 1);
		await source.stop();

		const params = rec.exception.mock.calls[0]?.[0] as {
			name: string;
			details: { stage: string; failedUids: number[] };
		};
		expect(params.name).toBe("imap.poll-failed");
		expect(params.details.stage).toBe("search");
		expect(params.details.failedUids).toEqual([]);
		expect(rec.fire).not.toHaveBeenCalled();
	});

	it("7.14 successful empty cycle emits no trigger.exception", async () => {
		const logger = makeLogger();
		const source = createImapTriggerSource({ logger });
		const desc = makeDescriptor({ port: server.port, search: "UNSEEN" });
		const rec = makeEntry(desc, async () => ({ ok: true, output: {} }));

		await source.reconfigure("o", "r", [rec.entry]);
		// Give the cycle time to run end-to-end. INBOX is empty → no fires.
		await new Promise((r) => setTimeout(r, 500));
		await source.stop();

		expect(rec.fire).not.toHaveBeenCalled();
		expect(rec.exception).not.toHaveBeenCalled();
		// No Pino warn lines either.
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("7.11 sentinel resolution is the registry's responsibility (covered by workflow-registry.test.ts)", () => {
		// Documented deviation: the source receives an already-resolved
		// descriptor; sentinel substitution is verified at the registry layer.
		// See task 4.4 in `add-imap-trigger/tasks.md`.
		expect(true).toBe(true);
	});
});
