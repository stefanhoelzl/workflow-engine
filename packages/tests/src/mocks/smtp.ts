import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import type { MailCapture } from "../types.js";
import type { Mock } from "./types.js";

interface SmtpConn {
	host: string;
	port: number;
	user: string;
	pass: string;
}

// Slug derivation from a single recipient — recipients of the form
// `dest+<slug>@test` carry the slug in the plus-address. Anything else
// has no slug (capture is still recorded for visibility).
function slugFromAddress(addr: string): string | undefined {
	const at = addr.indexOf("@");
	const local = at < 0 ? addr : addr.slice(0, at);
	const plus = local.indexOf("+");
	if (plus < 0) {
		return;
	}
	const slug = local.slice(plus + 1);
	return slug.length === 0 ? undefined : slug;
}

// Minimal RFC822 header parser — extracts the Subject line and splits
// headers from body. Sufficient for the e2e harness; not a full MIME
// parser. The mail plugin always sends a plain `text` body.
function parseRaw(raw: string): { subject: string; body: string } {
	const sep = raw.indexOf("\r\n\r\n");
	const headerBlock = sep < 0 ? raw : raw.slice(0, sep);
	const body = sep < 0 ? "" : raw.slice(sep + 4);
	let subject = "";
	for (const line of headerBlock.split("\r\n")) {
		if (line.toLowerCase().startsWith("subject:")) {
			subject = line.slice("subject:".length).trim();
			break;
		}
	}
	return { subject, body };
}

// In-memory SMTP catcher. AUTH PLAIN/LOGIN with random per-suite
// credentials; STARTTLS not advertised (the mail plugin's `tls:
// "plaintext"` mode is what test #18 uses, since the mock has no real
// cert). Captures one record per RCPT — a multi-RCPT message produces
// one capture per recipient, each with its own slug.
function createSmtpMock(): Mock<MailCapture, SmtpConn> {
	const user = `mockuser-${randomBytes(4).toString("hex")}`;
	const pass = `mockpass-${randomBytes(16).toString("hex")}`;
	let server: SMTPServer | null = null;
	let host = "127.0.0.1";
	let port = 0;
	return {
		name: "smtp",
		async start(record): Promise<SmtpConn> {
			server = new SMTPServer({
				authOptional: false,
				// `tls: "plaintext"` on the workflow side means no STARTTLS upgrade.
				// smtp-server refuses AUTH on a plaintext socket by default; the
				// catcher is loopback-only and runs in tests, so the relaxation
				// is local to this process.
				allowInsecureAuth: true,
				disabledCommands: ["STARTTLS"],
				secure: false,
				logger: false,
				onAuth(auth, _session, callback) {
					if (auth.username === user && auth.password === pass) {
						callback(null, { user: auth.username });
						return;
					}
					callback(new Error("invalid credentials"));
				},
				onData(stream, session, callback) {
					const chunks: Buffer[] = [];
					stream.on("data", (c: Buffer) => chunks.push(c));
					stream.on("end", () => {
						const raw = Buffer.concat(chunks).toString("utf8");
						const { subject, body } = parseRaw(raw);
						const from = session.envelope.mailFrom
							? session.envelope.mailFrom.address
							: "";
						const recipients = session.envelope.rcptTo.map((r) => r.address);
						for (const to of recipients) {
							const slug = slugFromAddress(to);
							record({
								ts: Date.now(),
								...(slug === undefined ? {} : { slug }),
								from,
								to: [to],
								subject,
								body,
							});
						}
						callback();
					});
					stream.on("error", (err) => callback(err));
				},
			});
			await new Promise<void>((res, rej) => {
				server?.listen(0, host, () => res());
				server?.on("error", rej);
			});
			const addr = server.server.address() as AddressInfo;
			port = addr.port;
			host = addr.address;
			return { host, port, user, pass };
		},
		async stop(): Promise<void> {
			if (!server) {
				return;
			}
			await new Promise<void>((res) => {
				server?.close(() => res());
			});
			server = null;
		},
	};
}

export type { SmtpConn };
export { createSmtpMock };
