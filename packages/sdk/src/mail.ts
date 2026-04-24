// `sendMail` is a thin guest-side wrapper over the locked `__mail.send`
// dispatcher installed by the sandbox-stdlib mail plugin. The only
// transformation it performs is mechanical attachment-content normalization
// (Blob | File | Uint8Array | ArrayBuffer | string → base64 string), so the
// host-side bridge schema stays monomorphic (`content: string`). Every other
// field is passed through unchanged — credentials in `smtp.auth`, recipients,
// subject, body, etc. The SDK does not inspect, redact, or validate them.

type Recipient = string | readonly string[];

type AttachmentContent = Blob | File | Uint8Array | ArrayBuffer | string;

interface SendMailAttachment {
	readonly filename: string;
	readonly content: AttachmentContent;
	readonly contentType?: string;
}

interface SendMailSmtp {
	readonly host: string;
	readonly port: number;
	readonly tls: "tls" | "starttls" | "plaintext";
	readonly auth: { readonly user: string; readonly pass: string };
	readonly timeout?: number;
}

interface SendMailOptions {
	readonly smtp: SendMailSmtp;
	readonly from: string;
	readonly to: Recipient;
	readonly cc?: Recipient;
	readonly bcc?: Recipient;
	readonly replyTo?: Recipient;
	readonly subject: string;
	readonly text?: string;
	readonly html?: string;
	readonly attachments?: readonly SendMailAttachment[];
}

interface SendMailResult {
	readonly messageId: string;
	readonly accepted: readonly string[];
	readonly rejected: readonly string[];
	// Raw SMTP response string from the server's final `250` acknowledgement
	// (present when the transport exposes it). Useful for provider-specific
	// correlation — e.g. ethereal.email encodes its preview-URL id as
	// `MSGID=<id>` inside this string.
	readonly response?: string;
}

type MailErrorKind =
	| "auth"
	| "recipient-rejected"
	| "message-rejected"
	| "connection"
	| "timeout";

interface MailError extends Error {
	readonly kind: MailErrorKind;
	readonly code?: string;
	readonly responseCode?: number;
	readonly response?: string;
}

interface MailDispatcher {
	send(opts: unknown): Promise<SendMailResult>;
}

function getMailDispatcher(): MailDispatcher {
	const mail = (globalThis as Record<string, unknown>).__mail as
		| MailDispatcher
		| undefined;
	if (!mail || typeof mail.send !== "function") {
		throw new Error(
			"Mail dispatcher unavailable; sendMail can only run inside the workflow sandbox",
		);
	}
	return mail;
}

// Chunked btoa: btoa expects a binary string, and `String.fromCharCode(...)`
// blows the call-stack arg limit for large buffers. 0x8000 is the same chunk
// size other base64 utilities in the codebase use.
const BASE64_CHUNK = 0x80_00;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
		const slice = bytes.subarray(i, i + BASE64_CHUNK);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

async function attachmentContentToBase64(
	content: AttachmentContent,
): Promise<string> {
	if (typeof content === "string") {
		return bytesToBase64(new TextEncoder().encode(content));
	}
	if (content instanceof Uint8Array) {
		return bytesToBase64(content);
	}
	if (content instanceof ArrayBuffer) {
		return bytesToBase64(new Uint8Array(content));
	}
	// Blob / File (File extends Blob) — `arrayBuffer()` is the WHATWG path.
	if (typeof (content as Blob)?.arrayBuffer === "function") {
		const buf = await (content as Blob).arrayBuffer();
		return bytesToBase64(new Uint8Array(buf));
	}
	throw new TypeError(
		"sendMail: attachment content must be Blob, File, Uint8Array, ArrayBuffer, or string",
	);
}

async function normalizeAttachments(
	attachments: readonly SendMailAttachment[],
): Promise<Array<{ filename: string; content: string; contentType?: string }>> {
	const out: Array<{
		filename: string;
		content: string;
		contentType?: string;
	}> = [];
	for (const a of attachments) {
		// biome-ignore lint/performance/noAwaitInLoops: mail attachments are a short list (typically 1–3); sequential await keeps normalization deterministic and avoids spawning Promise.all chains for a cold-path call
		const content = await attachmentContentToBase64(a.content);
		const entry: { filename: string; content: string; contentType?: string } = {
			filename: a.filename,
			content,
		};
		if (a.contentType !== undefined) {
			entry.contentType = a.contentType;
		}
		out.push(entry);
	}
	return out;
}

async function sendMail(opts: SendMailOptions): Promise<SendMailResult> {
	const mail = getMailDispatcher();
	if (opts.attachments === undefined) {
		return mail.send(opts);
	}
	const normalizedAttachments = await normalizeAttachments(opts.attachments);
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(opts)) {
		if (key === "attachments") {
			continue;
		}
		normalized[key] = value;
	}
	normalized.attachments = normalizedAttachments;
	return mail.send(normalized);
}

export type {
	AttachmentContent,
	MailError,
	MailErrorKind,
	SendMailAttachment,
	SendMailOptions,
	SendMailResult,
	SendMailSmtp,
};
export { sendMail };
