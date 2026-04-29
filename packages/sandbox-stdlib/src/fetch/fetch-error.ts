import { GuestSafeError } from "@workflow-engine/sandbox";

type FetchErrorReason =
	| "bad-scheme"
	| "invalid-url"
	| "private-address"
	| "redirect-loop"
	| "network-error"
	| "aborted";

interface FetchErrorOptions {
	readonly reason: FetchErrorReason;
	readonly url?: string;
	readonly code?: string;
	readonly message?: string;
}

/**
 * Bridge-safe fetch error. Constructed by the `$fetch/do` dispatcher's outer
 * catch translation table; carries a curated `reason` enum, the underlying
 * driver `code` (libuv / undici / OpenSSL TLS — surfaced verbatim from
 * `err.code`, no regex sanitisation), and the guest URL or final redirect
 * target. The closure rule in `bridge.ts`'s `buildHandler` propagates these
 * structured fields to the guest alongside `name` and `message`. See
 * `openspec/specs/sandbox-stdlib/spec.md` "FetchError shape for `$fetch/do`
 * failures".
 */
class FetchError extends GuestSafeError {
	override readonly name = "FetchError";
	readonly reason: FetchErrorReason;
	readonly url?: string;
	readonly code?: string;

	constructor(options: FetchErrorOptions) {
		const message = options.message ?? buildMessage(options);
		super(message);
		this.reason = options.reason;
		if (options.url !== undefined) {
			this.url = options.url;
		}
		if (options.code !== undefined) {
			this.code = options.code;
		}
	}
}

function buildMessage(options: FetchErrorOptions): string {
	const url = options.url ? `${options.url}: ` : "";
	switch (options.reason) {
		case "bad-scheme":
			return `${url}unsupported scheme`;
		case "invalid-url":
			return `${url}invalid URL`;
		case "private-address":
			return `${url}resolved to private address`;
		case "redirect-loop":
			return `${url}too many redirects`;
		case "aborted":
			return `${url}aborted`;
		case "network-error":
			return options.code
				? `${url}network error (${options.code})`
				: `${url}network error`;
		default:
			return `${url}fetch failed`;
	}
}

export type { FetchErrorOptions, FetchErrorReason };
export { FetchError };
