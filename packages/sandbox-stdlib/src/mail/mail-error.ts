import { GuestSafeError } from "@workflow-engine/sandbox";
import type { MailErrorKind } from "./types.js";

interface MailErrorOptions {
	readonly kind: MailErrorKind;
	readonly code?: string;
	readonly responseCode?: number;
	readonly response?: string;
	readonly message?: string;
}

/**
 * Bridge-safe mail error. Constructed by the `$mail/send` dispatcher's input
 * validators (kind = "invalid-input") and by the `classifyMailError` post-
 * nodemailer translator (kind ∈ "auth"/"timeout"/"connection"/…). The
 * underlying nodemailer `.message` is NOT forwarded (it can include host
 * filesystem paths from TLS file load failures); the message is constructed
 * from the structured fields below. See
 * `openspec/specs/sandbox-stdlib/spec.md` "MailError shape for `$mail/send`
 * failures".
 */
class MailError extends GuestSafeError {
	override readonly name = "MailError";
	readonly kind: MailErrorKind;
	readonly code?: string;
	readonly responseCode?: number;
	readonly response?: string;

	constructor(options: MailErrorOptions) {
		const message = options.message ?? buildMessage(options);
		super(message);
		this.kind = options.kind;
		if (options.code !== undefined) {
			this.code = options.code;
		}
		if (options.responseCode !== undefined) {
			this.responseCode = options.responseCode;
		}
		if (options.response !== undefined) {
			this.response = options.response;
		}
	}
}

function buildMessage(options: MailErrorOptions): string {
	let head: string = options.kind;
	if (options.code) {
		head = `${head} (${options.code})`;
	}
	let suffix = "";
	if (options.responseCode !== undefined) {
		suffix = `: ${options.responseCode}`;
		if (options.response) {
			suffix = `${suffix} ${options.response}`;
		}
	} else if (options.response) {
		suffix = `: ${options.response}`;
	}
	return head + suffix;
}

export type { MailErrorOptions };
export { MailError };
