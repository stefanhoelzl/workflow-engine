import type { SandboxContext } from "@workflow-engine/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DNS resolver used by net-guard so we can drive public / private /
// multi-address responses per test. Vitest hoists vi.mock() above imports.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(),
}));

// Mock nodemailer so we can observe the transport options the plugin passes,
// control the send() outcome, and simulate each error class without running
// a real SMTP session. `vi.hoisted` runs BEFORE the mock factory evaluates, so
// the shared spies survive into the test scope.
const nmMock = vi.hoisted(() => ({
	sendMail: vi.fn(),
	close: vi.fn(),
	createTransport: vi.fn() as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("nodemailer", () => {
	nmMock.createTransport = vi.fn(() => ({
		sendMail: nmMock.sendMail,
		close: nmMock.close,
	}));
	return {
		default: { createTransport: nmMock.createTransport },
		createTransport: nmMock.createTransport,
	};
});

import { lookup as mockLookup } from "node:dns/promises";
import { MAIL_DISPATCHER_NAME } from "./descriptor-name.js";
import { classifyMailError, dispatchMailSend, worker } from "./worker.js";

const lookup = vi.mocked(mockLookup) as unknown as {
	mockResolvedValueOnce: (
		value: Array<{ address: string; family: 4 | 6 }>,
	) => void;
	mockReset: () => void;
};

beforeEach(() => {
	lookup.mockReset();
	nmMock.sendMail.mockReset();
	nmMock.close.mockReset();
	nmMock.createTransport.mockClear();
});

function mockPublicHost(addr = "93.184.216.34"): void {
	lookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
}

function validOpts(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		smtp: {
			host: "smtp.example.com",
			port: 587,
			tls: "starttls" as const,
			auth: { user: "u", pass: "p" },
		},
		from: "sender@example.com",
		to: "recipient@example.com",
		subject: "hi",
		text: "body",
		...overrides,
	};
}

describe("mail plugin — descriptor shape", () => {
	it("exposes name + dependsOn + dispatcher descriptor with log.request:'system'", () => {
		const noopCtx: SandboxContext = {
			emit() {
				return 0 as never;
			},
			request(_p, _o, fn) {
				return fn();
			},
		};
		const setup = worker(noopCtx);
		expect(setup.guestFunctions).toHaveLength(1);
		const gf = setup.guestFunctions?.[0];
		expect(gf?.name).toBe(MAIL_DISPATCHER_NAME);
		expect(gf?.public).toBe(false);
		expect(gf?.log).toEqual({ request: "system" });
	});

	it("logName uses the first recipient", () => {
		const noopCtx: SandboxContext = {
			emit() {
				return 0 as never;
			},
			request(_p, _o, fn) {
				return fn();
			},
		};
		const gf = worker(noopCtx).guestFunctions?.[0];
		const name = gf?.logName?.([
			{ to: ["a@example.com", "b@example.com"] } as unknown,
		]);
		expect(name).toBe("sendMail a@example.com");
	});

	it("logInput strips text/html/attachments AND smtp.auth", () => {
		const noopCtx: SandboxContext = {
			emit() {
				return 0 as never;
			},
			request(_p, _o, fn) {
				return fn();
			},
		};
		const gf = worker(noopCtx).guestFunctions?.[0];
		const picked = gf?.logInput?.([
			{
				smtp: {
					host: "h",
					port: 25,
					tls: "plaintext",
					auth: { user: "u", pass: "secret" },
					timeout: 15_000,
				},
				from: "f",
				to: "t",
				cc: "c",
				bcc: "b",
				replyTo: "r",
				subject: "s",
				text: "BODY",
				html: "<b>BODY</b>",
				attachments: [{ filename: "x", content: "base64==" }],
			} as unknown,
		]) as Record<string, unknown>;
		expect(picked).toBeDefined();
		expect(picked.text).toBeUndefined();
		expect(picked.html).toBeUndefined();
		expect(picked.attachments).toBeUndefined();
		expect(picked.subject).toBe("s");
		expect(picked.cc).toBe("c");
		expect(picked.bcc).toBe("b");
		expect(picked.replyTo).toBe("r");
		// smtp envelope retains transport metadata; auth is dropped — credentials
		// don't go into the audit message in the first place. The runtime secrets
		// plugin's onPost scrubber is the backstop for credentials bound via
		// env({secret:true}). See design Decision 7.
		const smtp = picked.smtp as {
			host: string;
			port: number;
			tls: string;
			timeout?: number;
			auth?: unknown;
		};
		expect(smtp.host).toBe("h");
		expect(smtp.port).toBe(25);
		expect(smtp.tls).toBe("plaintext");
		expect(smtp.timeout).toBe(15_000);
		expect(smtp.auth).toBeUndefined();
	});
});

describe("mail plugin — dispatchMailSend", () => {
	it("returns {messageId, accepted, rejected} on success", async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m@example.com>",
			accepted: ["recipient@example.com"],
			rejected: [],
		});

		const result = await dispatchMailSend(validOpts() as never);
		expect(result).toEqual({
			messageId: "<m@example.com>",
			accepted: ["recipient@example.com"],
			rejected: [],
		});
	});

	it('maps tls:"tls" → {secure:true}', async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		await dispatchMailSend(
			validOpts({
				smtp: {
					host: "smtp.example.com",
					port: 465,
					tls: "tls",
					auth: { user: "u", pass: "p" },
				},
			}) as never,
		);
		const opts = nmMock.createTransport.mock.calls[0]?.[0];
		expect(opts.secure).toBe(true);
		expect(opts.requireTLS).toBeUndefined();
		expect(opts.ignoreTLS).toBeUndefined();
	});

	it('maps tls:"starttls" → {secure:false, requireTLS:true}', async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		await dispatchMailSend(validOpts() as never);
		const opts = nmMock.createTransport.mock.calls[0]?.[0];
		expect(opts.secure).toBe(false);
		expect(opts.requireTLS).toBe(true);
		expect(opts.ignoreTLS).toBeUndefined();
	});

	it('maps tls:"plaintext" → {secure:false, ignoreTLS:true}', async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		await dispatchMailSend(
			validOpts({
				smtp: {
					host: "smtp.example.com",
					port: 25,
					tls: "plaintext",
					auth: { user: "u", pass: "p" },
				},
			}) as never,
		);
		const opts = nmMock.createTransport.mock.calls[0]?.[0];
		expect(opts.secure).toBe(false);
		expect(opts.ignoreTLS).toBe(true);
		expect(opts.requireTLS).toBeUndefined();
	});

	it("defaults timeout to 30_000ms on both connection + socket", async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		await dispatchMailSend(validOpts() as never);
		const opts = nmMock.createTransport.mock.calls[0]?.[0];
		expect(opts.connectionTimeout).toBe(30_000);
		expect(opts.socketTimeout).toBe(30_000);
	});

	it("honours smtp.timeout override on both connection + socket", async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		await dispatchMailSend(
			validOpts({
				smtp: {
					host: "smtp.example.com",
					port: 587,
					tls: "starttls",
					auth: { user: "u", pass: "p" },
					timeout: 15_000,
				},
			}) as never,
		);
		const opts = nmMock.createTransport.mock.calls[0]?.[0];
		expect(opts.connectionTimeout).toBe(15_000);
		expect(opts.socketTimeout).toBe(15_000);
	});

	it("pre-resolves host to an IP and sets tls.servername to the original hostname", async () => {
		mockPublicHost("93.184.216.34");
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		await dispatchMailSend(validOpts() as never);
		const opts = nmMock.createTransport.mock.calls[0]?.[0];
		expect(opts.host).toBe("93.184.216.34");
		expect(opts.tls?.servername).toBe("smtp.example.com");
	});

	it("rejects private-IP hosts before constructing the transport", async () => {
		lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
		await expect(dispatchMailSend(validOpts() as never)).rejects.toMatchObject({
			name: "HostBlockedError",
		});
		expect(nmMock.createTransport).not.toHaveBeenCalled();
	});

	it("base64-decodes attachment content before handing to nodemailer", async () => {
		mockPublicHost();
		nmMock.sendMail.mockResolvedValueOnce({
			messageId: "<m>",
			accepted: [],
			rejected: [],
		});
		// "hello" in base64
		await dispatchMailSend(
			validOpts({
				attachments: [
					{
						filename: "note.txt",
						content: "aGVsbG8=",
						contentType: "text/plain",
					},
				],
			}) as never,
		);
		const msg = nmMock.sendMail.mock.calls[0]?.[0];
		const buf = msg.attachments[0].content as Buffer;
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect(buf.toString("utf8")).toBe("hello");
	});
});

describe("mail plugin — error classification", () => {
	it('code:"EAUTH" → kind:"auth", preserves responseCode + response', () => {
		const e = classifyMailError({
			code: "EAUTH",
			responseCode: 535,
			response: "535 5.7.8 auth failed",
			message: "Invalid login",
		});
		expect(e.kind).toBe("auth");
		expect(e.responseCode).toBe(535);
		expect(e.response).toBe("535 5.7.8 auth failed");
	});

	it('code:"EENVELOPE" → kind:"recipient-rejected"', () => {
		const e = classifyMailError({ code: "EENVELOPE", message: "no recipient" });
		expect(e.kind).toBe("recipient-rejected");
	});

	it('code:"ETIMEDOUT" → kind:"timeout"', () => {
		const e = classifyMailError({ code: "ETIMEDOUT", message: "timed out" });
		expect(e.kind).toBe("timeout");
	});

	it('code:"ECONNECTION" → kind:"connection"', () => {
		const e = classifyMailError({ code: "ECONNECTION", message: "refused" });
		expect(e.kind).toBe("connection");
	});

	it('code:"EMESSAGE" → kind:"message-rejected"', () => {
		const e = classifyMailError({ code: "EMESSAGE", message: "rejected" });
		expect(e.kind).toBe("message-rejected");
	});

	it('command:"DATA" with no recognized code → kind:"message-rejected"', () => {
		const e = classifyMailError({ command: "DATA", message: "550 bad body" });
		expect(e.kind).toBe("message-rejected");
	});

	it("falls back to kind:'connection' for unknown error shapes", () => {
		const e = classifyMailError({ message: "boom" });
		expect(e.kind).toBe("connection");
	});
});

describe("mail plugin — structured throw on send failure", () => {
	it("rethrows nodemailer errors as MailError with discriminator", async () => {
		mockPublicHost();
		const smtpErr = Object.assign(new Error("Invalid login: 535 5.7.8"), {
			code: "EAUTH",
			responseCode: 535,
			response: "535 5.7.8 auth failed",
		});
		nmMock.sendMail.mockRejectedValueOnce(smtpErr);

		await expect(dispatchMailSend(validOpts() as never)).rejects.toMatchObject({
			name: "MailError",
			kind: "auth",
			code: "EAUTH",
			responseCode: 535,
			response: "535 5.7.8 auth failed",
		});
	});
});
