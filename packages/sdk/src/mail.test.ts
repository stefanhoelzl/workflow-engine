import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMail } from "./mail.js";

interface BridgedCall {
	opts: Record<string, unknown>;
}

function installMockDispatcher(): BridgedCall[] {
	const calls: BridgedCall[] = [];
	const send = vi.fn(async (opts: unknown) => {
		calls.push({ opts: opts as Record<string, unknown> });
		return { messageId: "<m>", accepted: ["a@x"], rejected: [] };
	});
	Object.defineProperty(globalThis, "__mail", {
		value: Object.freeze({ send }),
		writable: false,
		configurable: true,
		enumerable: false,
	});
	return calls;
}

function uninstallMockDispatcher(): void {
	// biome-ignore lint/performance/noDelete: __mail is installed via Object.defineProperty with writable:false, so plain assignment (`= undefined`) throws; delete + configurable:true is the only way to reset it between tests
	delete (globalThis as unknown as { __mail?: unknown }).__mail;
}

beforeEach(() => {
	uninstallMockDispatcher();
});
afterEach(() => {
	uninstallMockDispatcher();
});

function baseOpts(): {
	smtp: {
		host: string;
		port: number;
		tls: "starttls";
		auth: { user: string; pass: string };
	};
	from: string;
	to: string;
	subject: string;
} {
	return {
		smtp: {
			host: "smtp.example.com",
			port: 587,
			tls: "starttls",
			auth: { user: "u", pass: "secret" },
		},
		from: "sender@example.com",
		to: "rcpt@example.com",
		subject: "s",
	};
}

describe("sendMail — dispatcher unavailable", () => {
	it("throws when __mail is not installed (outside the sandbox)", async () => {
		await expect(sendMail(baseOpts())).rejects.toThrow(
			/Mail dispatcher unavailable/,
		);
	});
});

describe("sendMail — attachment normalization", () => {
	it("Uint8Array → base64 string", async () => {
		const calls = installMockDispatcher();
		const bytes = new Uint8Array([104, 105]); // "hi"
		await sendMail({
			...baseOpts(),
			attachments: [{ filename: "a.bin", content: bytes }],
		});
		const attachments = (
			calls[0]?.opts as { attachments: Array<{ content: string }> }
		).attachments;
		expect(attachments[0]?.content).toBe(btoa("hi"));
	});

	it("ArrayBuffer → base64 string", async () => {
		const calls = installMockDispatcher();
		const bytes = new Uint8Array([104, 105]);
		await sendMail({
			...baseOpts(),
			attachments: [{ filename: "a.bin", content: bytes.buffer }],
		});
		const attachments = (
			calls[0]?.opts as { attachments: Array<{ content: string }> }
		).attachments;
		expect(attachments[0]?.content).toBe(btoa("hi"));
	});

	it("string → base64 of the UTF-8 bytes", async () => {
		const calls = installMockDispatcher();
		await sendMail({
			...baseOpts(),
			attachments: [
				{ filename: "note.txt", content: "hello", contentType: "text/plain" },
			],
		});
		const attachments = (
			calls[0]?.opts as {
				attachments: Array<{ content: string; contentType?: string }>;
			}
		).attachments;
		expect(attachments[0]?.content).toBe(btoa("hello"));
		expect(attachments[0]?.contentType).toBe("text/plain");
	});

	it("string with multibyte UTF-8 → base64 of multibyte bytes", async () => {
		const calls = installMockDispatcher();
		await sendMail({
			...baseOpts(),
			attachments: [{ filename: "u.txt", content: "héllo" }],
		});
		const attachments = (
			calls[0]?.opts as { attachments: Array<{ content: string }> }
		).attachments;
		const expected = btoa(
			String.fromCharCode(...new TextEncoder().encode("héllo")),
		);
		expect(attachments[0]?.content).toBe(expected);
	});

	it("Blob → base64 string", async () => {
		const calls = installMockDispatcher();
		const blob = new Blob(["hi"]);
		await sendMail({
			...baseOpts(),
			attachments: [{ filename: "b.bin", content: blob }],
		});
		const attachments = (
			calls[0]?.opts as { attachments: Array<{ content: string }> }
		).attachments;
		expect(attachments[0]?.content).toBe(btoa("hi"));
	});

	it("File → base64 string", async () => {
		const calls = installMockDispatcher();
		const file = new File(["hi"], "greeting.txt");
		await sendMail({
			...baseOpts(),
			attachments: [{ filename: file.name, content: file }],
		});
		const attachments = (
			calls[0]?.opts as { attachments: Array<{ content: string }> }
		).attachments;
		expect(attachments[0]?.content).toBe(btoa("hi"));
	});

	it("rejects an unsupported content type with a TypeError", async () => {
		installMockDispatcher();
		await expect(
			sendMail({
				...baseOpts(),
				attachments: [
					{
						filename: "x",
						content: 42 as unknown as Uint8Array,
					},
				],
			}),
		).rejects.toBeInstanceOf(TypeError);
	});
});

describe("sendMail — non-attachment passthrough", () => {
	it("passes smtp (including smtp.auth.pass), subject, from, to through unmodified", async () => {
		const calls = installMockDispatcher();
		await sendMail({
			...baseOpts(),
			cc: ["c1@x", "c2@x"],
			bcc: "b@x",
			replyTo: "r@x",
			text: "hello",
			html: "<b>hello</b>",
		});
		const opts = calls[0]?.opts as Record<string, unknown> & {
			smtp: { auth: { pass: string } };
		};
		expect(opts.smtp.auth.pass).toBe("secret");
		expect(opts.from).toBe("sender@example.com");
		expect(opts.to).toBe("rcpt@example.com");
		expect(opts.subject).toBe("s");
		expect(opts.cc).toEqual(["c1@x", "c2@x"]);
		expect(opts.bcc).toBe("b@x");
		expect(opts.replyTo).toBe("r@x");
		expect(opts.text).toBe("hello");
		expect(opts.html).toBe("<b>hello</b>");
	});

	it("returns the resolved {messageId, accepted, rejected} unchanged", async () => {
		installMockDispatcher();
		const result = await sendMail(baseOpts());
		expect(result).toEqual({
			messageId: "<m>",
			accepted: ["a@x"],
			rejected: [],
		});
	});

	it("passes options through verbatim when no attachments are present", async () => {
		const calls = installMockDispatcher();
		const opts = baseOpts();
		await sendMail(opts);
		// Without attachments the SDK should not re-shape the object.
		expect(calls[0]?.opts).toBe(opts);
	});

	it("propagates structured MailError from the bridge", async () => {
		const structuredErr = Object.assign(new Error("auth failed"), {
			name: "MailError",
			kind: "auth",
			code: "EAUTH",
			responseCode: 535,
			response: "535 5.7.8 ...",
		});
		Object.defineProperty(globalThis, "__mail", {
			value: Object.freeze({
				send: vi.fn().mockRejectedValueOnce(structuredErr),
			}),
			writable: false,
			configurable: true,
			enumerable: false,
		});
		await expect(sendMail(baseOpts())).rejects.toMatchObject({
			name: "MailError",
			kind: "auth",
			code: "EAUTH",
			responseCode: 535,
			response: "535 5.7.8 ...",
		});
	});
});
