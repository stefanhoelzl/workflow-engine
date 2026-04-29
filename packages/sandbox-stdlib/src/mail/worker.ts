import type {
	GuestFunctionDescription,
	PluginContext,
	PluginSetup,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";
import nodemailer, { type Transporter } from "nodemailer";
import type SmtpTransport from "nodemailer/lib/smtp-transport/index.js";
import { createRunScopedHandles } from "../internal/run-scoped-handles.js";
import { assertHostIsPublic } from "../net-guard/index.js";
import { MAIL_DISPATCHER_NAME } from "./descriptor-name.js";
import type { MailErrorOptions } from "./mail-error.js";
import { MailError } from "./mail-error.js";
import type {
	MailAttachmentWire,
	MailErrorKind,
	MailOptsWire,
	MailResultWire,
	Recipient,
	SmtpConfigWire,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

type SmtpTransporter = Transporter<
	SmtpTransport.SentMessageInfo,
	SmtpTransport.Options
>;

// `nodemailer.createTransport()` is synchronous and opens no socket — it
// constructs an SMTPTransport + Mailer wrapper; sockets are opened lazily
// inside `sendMail`. So `track` immediately after construction is correct:
// the handle represents the future socket lifecycle bound to this Mail
// instance. `Mail.close()` (verified against nodemailer 6.10.1) is sync,
// idempotent under double-call (`removeAllListeners` + `emit('close')`,
// no I/O), and cannot hang.
const handles = createRunScopedHandles<SmtpTransporter>((transport) => {
	try {
		transport.close();
	} catch {
		// Idempotent under double-call against nodemailer 6.x.
	}
});

function assertPositiveInt(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new MailError({
			kind: "invalid-input",
			message: `${path} must be a positive integer`,
		});
	}
	return value;
}

function assertNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new MailError({
			kind: "invalid-input",
			message: `${path} must be a non-empty string`,
		});
	}
	return value;
}

function assertRecipient(value: unknown, path: string): Recipient {
	if (typeof value === "string") {
		if (value.length === 0) {
			throw new MailError({
				kind: "invalid-input",
				message: `${path} must be non-empty`,
			});
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			throw new MailError({
				kind: "invalid-input",
				message: `${path} must not be an empty array`,
			});
		}
		for (const [i, entry] of value.entries()) {
			if (typeof entry !== "string" || entry.length === 0) {
				throw new MailError({
					kind: "invalid-input",
					message: `${path}[${i}] must be a non-empty string`,
				});
			}
		}
		return value as readonly string[];
	}
	throw new MailError({
		kind: "invalid-input",
		message: `${path} must be a string or array of strings`,
	});
}

function assertOptionalRecipient(
	value: unknown,
	path: string,
): Recipient | undefined {
	if (value === undefined) {
		return;
	}
	return assertRecipient(value, path);
}

function assertOptionalString(
	value: unknown,
	path: string,
): string | undefined {
	if (value === undefined) {
		return;
	}
	if (typeof value !== "string") {
		throw new MailError({
			kind: "invalid-input",
			message: `${path} must be a string if provided`,
		});
	}
	return value;
}

function assertSmtpConfig(raw: unknown): SmtpConfigWire {
	if (raw === null || typeof raw !== "object") {
		throw new MailError({
			kind: "invalid-input",
			message: "smtp must be an object",
		});
	}
	const o = raw as Record<string, unknown>;
	const host = assertNonEmptyString(o.host, "smtp.host");
	const port = assertPositiveInt(o.port, "smtp.port");
	const tls = o.tls;
	if (tls !== "tls" && tls !== "starttls" && tls !== "plaintext") {
		throw new MailError({
			kind: "invalid-input",
			message: 'smtp.tls must be one of "tls" | "starttls" | "plaintext"',
		});
	}
	if (o.auth === null || typeof o.auth !== "object") {
		throw new MailError({
			kind: "invalid-input",
			message: "smtp.auth must be an object",
		});
	}
	const auth = o.auth as Record<string, unknown>;
	const user = assertNonEmptyString(auth.user, "smtp.auth.user");
	if (typeof auth.pass !== "string") {
		throw new MailError({
			kind: "invalid-input",
			message: "smtp.auth.pass must be a string",
		});
	}
	const config: {
		host: string;
		port: number;
		tls: "tls" | "starttls" | "plaintext";
		auth: { user: string; pass: string };
		timeout?: number;
	} = {
		host,
		port,
		tls,
		auth: { user, pass: auth.pass },
	};
	if (o.timeout !== undefined) {
		config.timeout = assertPositiveInt(o.timeout, "smtp.timeout");
	}
	return config;
}

function assertAttachments(
	raw: unknown,
): readonly MailAttachmentWire[] | undefined {
	if (raw === undefined) {
		return;
	}
	if (!Array.isArray(raw)) {
		throw new MailError({
			kind: "invalid-input",
			message: "attachments must be an array",
		});
	}
	const out: MailAttachmentWire[] = [];
	for (const [i, entry] of raw.entries()) {
		if (entry === null || typeof entry !== "object") {
			throw new MailError({
				kind: "invalid-input",
				message: `attachments[${i}] must be an object`,
			});
		}
		const a = entry as Record<string, unknown>;
		const filename = assertNonEmptyString(
			a.filename,
			`attachments[${i}].filename`,
		);
		if (typeof a.content !== "string") {
			throw new MailError({
				kind: "invalid-input",
				message: `attachments[${i}].content must be a base64 string`,
			});
		}
		const contentType = assertOptionalString(
			a.contentType,
			`attachments[${i}].contentType`,
		);
		const result: MailAttachmentWire = contentType
			? { filename, content: a.content, contentType }
			: { filename, content: a.content };
		out.push(result);
	}
	return out;
}

function assertMailOpts(raw: unknown): MailOptsWire {
	if (raw === null || typeof raw !== "object") {
		throw new MailError({
			kind: "invalid-input",
			message: "options must be an object",
		});
	}
	const o = raw as Record<string, unknown>;
	const opts: {
		smtp: SmtpConfigWire;
		from: string;
		to: Recipient;
		cc?: Recipient;
		bcc?: Recipient;
		replyTo?: Recipient;
		subject: string;
		text?: string;
		html?: string;
		attachments?: readonly MailAttachmentWire[];
	} = {
		smtp: assertSmtpConfig(o.smtp),
		from: assertNonEmptyString(o.from, "from"),
		to: assertRecipient(o.to, "to"),
		subject: assertNonEmptyString(o.subject, "subject"),
	};
	const cc = assertOptionalRecipient(o.cc, "cc");
	if (cc !== undefined) {
		opts.cc = cc;
	}
	const bcc = assertOptionalRecipient(o.bcc, "bcc");
	if (bcc !== undefined) {
		opts.bcc = bcc;
	}
	const replyTo = assertOptionalRecipient(o.replyTo, "replyTo");
	if (replyTo !== undefined) {
		opts.replyTo = replyTo;
	}
	const text = assertOptionalString(o.text, "text");
	if (text !== undefined) {
		opts.text = text;
	}
	const html = assertOptionalString(o.html, "html");
	if (html !== undefined) {
		opts.html = html;
	}
	const attachments = assertAttachments(o.attachments);
	if (attachments !== undefined) {
		opts.attachments = attachments;
	}
	return opts;
}

function mapTlsMode(tls: "tls" | "starttls" | "plaintext"): {
	secure: boolean;
	// biome-ignore lint/style/useNamingConvention: `requireTLS` mirrors nodemailer's SMTPTransport.Options field name verbatim — renaming would desync the spread into transportOptions
	requireTLS?: boolean;
	// biome-ignore lint/style/useNamingConvention: `ignoreTLS` mirrors nodemailer's SMTPTransport.Options field name verbatim
	ignoreTLS?: boolean;
} {
	switch (tls) {
		case "tls":
			return { secure: true };
		case "starttls":
			// biome-ignore lint/style/useNamingConvention: requireTLS is nodemailer's exact SMTPTransport.Options key
			return { secure: false, requireTLS: true };
		case "plaintext":
			// biome-ignore lint/style/useNamingConvention: ignoreTLS is nodemailer's exact SMTPTransport.Options key
			return { secure: false, ignoreTLS: true };
		default:
			throw new MailError({
				kind: "invalid-input",
				message: `unreachable tls mode ${String(tls)}`,
			});
	}
}

// Nodemailer error classification. `err.code` is the stable surface (string
// tags like "EAUTH", "EENVELOPE", "ETIMEDOUT", "ECONNECTION"); `responseCode`
// carries the numeric SMTP code when the failure came from the server;
// `command` narrows message-data rejection vs RCPT-TO rejection. The
// nodemailer `.message` is intentionally NOT forwarded — it can carry host
// fs paths from TLS file-load failures (`ENOENT: open '/etc/ssl/...'`); the
// MailError constructor builds a curated message from the structured
// fields below per `openspec/specs/sandbox-stdlib/spec.md`.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the classifier is inherently a switchboard over nodemailer's error-code surface; an if-chain per kind is the clearest form
function classifyMailError(err: unknown): MailErrorOptions {
	const e = (err ?? {}) as {
		code?: unknown;
		responseCode?: unknown;
		response?: unknown;
		command?: unknown;
	};
	const code = typeof e.code === "string" ? e.code : undefined;
	const responseCode =
		typeof e.responseCode === "number" ? e.responseCode : undefined;
	const response = typeof e.response === "string" ? e.response : undefined;
	const command = typeof e.command === "string" ? e.command : undefined;

	let kind: MailErrorKind;
	if (code === "EAUTH") {
		kind = "auth";
	} else if (code === "ETIMEDOUT" || code === "ETIME") {
		kind = "timeout";
	} else if (
		code === "ECONNECTION" ||
		code === "ECONNREFUSED" ||
		code === "EDNS" ||
		code === "ESOCKET"
	) {
		kind = "connection";
	} else if (code === "EENVELOPE") {
		kind = "recipient-rejected";
	} else if (code === "EMESSAGE" || command === "DATA") {
		kind = "message-rejected";
	} else {
		kind = "connection";
	}

	const base: {
		kind: MailErrorKind;
		code?: string;
		responseCode?: number;
		response?: string;
	} = { kind };
	if (code !== undefined) {
		base.code = code;
	}
	if (responseCode !== undefined) {
		base.responseCode = responseCode;
	}
	if (response !== undefined) {
		base.response = response;
	}
	return base;
}

function throwStructured(err: unknown): never {
	if (err instanceof MailError) {
		throw err;
	}
	throw new MailError(classifyMailError(err));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the handler is a sequential recipe — net-guard → transport options → conditional message fields → send → close; splitting the conditional `message.cc/bcc/replyTo/…` assignments into helpers would obscure the recipe order
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: see preceding comment — function length reflects the number of optional nodemailer fields, not compounded logic
async function dispatchMailSend(opts: MailOptsWire): Promise<MailResultWire> {
	// Net-guard: resolve + validate the host BEFORE constructing the transport.
	// Hands nodemailer the validated IP while preserving SNI + certificate
	// validation via `tls.servername`. Closes the TOCTOU window.
	const resolvedIp = await assertHostIsPublic(opts.smtp.host);

	const timeout = opts.smtp.timeout ?? DEFAULT_TIMEOUT_MS;
	const tlsMode = mapTlsMode(opts.smtp.tls);

	const transportOptions: SmtpTransport.Options = {
		host: resolvedIp,
		port: opts.smtp.port,
		secure: tlsMode.secure,
		auth: {
			user: opts.smtp.auth.user,
			pass: opts.smtp.auth.pass,
		},
		connectionTimeout: timeout,
		socketTimeout: timeout,
		greetingTimeout: timeout,
		tls: { servername: opts.smtp.host },
	};
	if (tlsMode.requireTLS) {
		transportOptions.requireTLS = true;
	}
	if (tlsMode.ignoreTLS) {
		transportOptions.ignoreTLS = true;
	}

	const transport = handles.track(nodemailer.createTransport(transportOptions));

	const attachments = opts.attachments?.map((a) => {
		const attachment: {
			filename: string;
			content: Buffer;
			contentType?: string;
		} = {
			filename: a.filename,
			content: Buffer.from(a.content, "base64"),
		};
		if (a.contentType !== undefined) {
			attachment.contentType = a.contentType;
		}
		return attachment;
	});

	const message: Parameters<typeof transport.sendMail>[0] = {
		from: opts.from,
		to: opts.to as string | string[],
		subject: opts.subject,
	};
	if (opts.cc !== undefined) {
		message.cc = opts.cc as string | string[];
	}
	if (opts.bcc !== undefined) {
		message.bcc = opts.bcc as string | string[];
	}
	if (opts.replyTo !== undefined) {
		message.replyTo = Array.isArray(opts.replyTo)
			? (opts.replyTo as string[]).join(", ")
			: (opts.replyTo as string);
	}
	if (opts.text !== undefined) {
		message.text = opts.text;
	}
	if (opts.html !== undefined) {
		message.html = opts.html;
	}
	if (attachments !== undefined) {
		message.attachments = attachments;
	}

	let info: Awaited<ReturnType<typeof transport.sendMail>>;
	try {
		info = await transport.sendMail(message);
	} catch (err) {
		throwStructured(err);
	} finally {
		await handles.release(transport);
	}

	const result: {
		messageId: string;
		accepted: string[];
		rejected: string[];
		response?: string;
	} = {
		messageId: info.messageId,
		accepted: (info.accepted ?? []).map((a) =>
			typeof a === "string" ? a : a.address,
		),
		rejected: (info.rejected ?? []).map((a) =>
			typeof a === "string" ? a : a.address,
		),
	};
	if (typeof (info as { response?: unknown }).response === "string") {
		result.response = (info as { response: string }).response;
	}
	return result;
}

function firstRecipient(to: Recipient): string {
	return typeof to === "string" ? to : (to[0] ?? "unknown");
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: descriptor body grew slightly with the publicName field; the structure remains a flat dictionary of well-named fields, not compounded logic
function mailDispatcherDescriptor(): GuestFunctionDescription {
	return {
		name: MAIL_DISPATCHER_NAME,
		// Guest-facing alias used by the bridge-closure rule for the
		// `sendMail failed: …` message prefix and the `<bridge:sendMail>`
		// synthetic stack frame on error paths.
		publicName: "sendMail",
		args: [Guest.raw()],
		result: Guest.raw(),
		handler: (async (raw: unknown) => {
			const opts = assertMailOpts(raw);
			const result = await dispatchMailSend(opts);
			return result as unknown as Record<string, unknown>;
		}) as unknown as GuestFunctionDescription["handler"],
		log: { request: "system" },
		logName: (args) => {
			const opts = args[0] as MailOptsWire | undefined;
			if (!opts || typeof opts !== "object") {
				return "sendMail";
			}
			const to = (opts as { to?: Recipient }).to;
			return `sendMail ${to ? firstRecipient(to) : "unknown"}`;
		},
		// Log envelope only — bodies + attachments routinely contain PII and
		// can be multi-MB. smtp.auth is also dropped: by the same
		// Authorization-header rule fetch follows (SECURITY.md §4), credentials
		// don't go into the message in the first place. The runtime `secrets`
		// plugin's onPost scrubber catches every registered plaintext as a
		// backstop for credentials bound via env({secret:true}).
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the field-by-field pick is the simplest readable form of the logInput filter; rewriting as a `pickFields()` helper obscures the deliberate envelope/body split
		logInput: (args) => {
			const opts = args[0] as MailOptsWire | undefined;
			if (!opts || typeof opts !== "object") {
				return args;
			}
			const picked: Record<string, unknown> = {};
			if (opts.smtp !== undefined) {
				const { host, port, tls, timeout } = opts.smtp;
				const smtpEnvelope: Record<string, unknown> = { host, port, tls };
				if (timeout !== undefined) {
					smtpEnvelope.timeout = timeout;
				}
				picked.smtp = smtpEnvelope;
			}
			if (opts.from !== undefined) {
				picked.from = opts.from;
			}
			if (opts.to !== undefined) {
				picked.to = opts.to;
			}
			if (opts.cc !== undefined) {
				picked.cc = opts.cc;
			}
			if (opts.bcc !== undefined) {
				picked.bcc = opts.bcc;
			}
			if (opts.replyTo !== undefined) {
				picked.replyTo = opts.replyTo;
			}
			if (opts.subject !== undefined) {
				picked.subject = opts.subject;
			}
			return picked;
		},
		public: false,
	};
}

function worker(_ctx: PluginContext): PluginSetup {
	return {
		guestFunctions: [mailDispatcherDescriptor()],
		onRunFinished: handles.drain,
	};
}

export { classifyMailError, dispatchMailSend, worker };
