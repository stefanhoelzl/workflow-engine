// Wire shapes for the `$mail/send` bridge. Shared between the worker
// implementation and tests. Keeping types in a separate file lets the
// guest-pass treeshake discard the nodemailer-coupled worker module while
// still importing these pure types without side effects.

type Recipient = string | readonly string[];

type MailErrorKind =
	| "invalid-input"
	| "auth"
	| "recipient-rejected"
	| "message-rejected"
	| "connection"
	| "timeout";

interface MailAttachmentWire {
	readonly filename: string;
	readonly content: string; // base64
	readonly contentType?: string;
}

interface SmtpConfigWire {
	readonly host: string;
	readonly port: number;
	readonly tls: "tls" | "starttls" | "plaintext";
	readonly auth: { readonly user: string; readonly pass: string };
	readonly timeout?: number;
}

interface MailOptsWire {
	readonly smtp: SmtpConfigWire;
	readonly from: string;
	readonly to: Recipient;
	readonly cc?: Recipient;
	readonly bcc?: Recipient;
	readonly replyTo?: Recipient;
	readonly subject: string;
	readonly text?: string;
	readonly html?: string;
	readonly attachments?: readonly MailAttachmentWire[];
}

interface MailResultWire {
	readonly messageId: string;
	readonly accepted: readonly string[];
	readonly rejected: readonly string[];
	// Raw SMTP response string from the server's final `250` acknowledgement
	// (present when the transport exposes it — nodemailer's SMTP transport
	// always does). Useful for provider-specific correlation (e.g. ethereal's
	// preview-URL parser reads `MSGID=…` out of this).
	readonly response?: string;
}

export type {
	MailAttachmentWire,
	MailErrorKind,
	MailOptsWire,
	MailResultWire,
	Recipient,
	SmtpConfigWire,
};
