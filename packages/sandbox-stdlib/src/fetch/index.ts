import type {
	GuestFunctionDescription,
	PluginContext,
	PluginSetup,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";
import { createRunScopedHandles } from "../internal/run-scoped-handles.js";
import { HostBlockedError } from "../net-guard/index.js";
import { FetchError } from "./fetch-error.js";
import { hardenedFetch } from "./hardened-fetch.js";

// The private descriptor name exposed to plugin source only — owner code
// never sees this (Phase-3 deletion removes it after the WHATWG polyfill
// captures it). `$` is a valid JS-identifier char; the leading sigil makes
// it obvious this binding is structural, not meant for direct use.
const FETCH_DISPATCHER_NAME = "$fetch/do";

type FetchImpl = typeof globalThis.fetch;

interface FetchResponseWire {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}

interface DispatchFetchArgs {
	readonly fetchImpl: FetchImpl;
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: string | null;
}

// Run-scoped tracker for in-flight requests' AbortControllers. The closer
// aborts the controller, which cascades through composeSignal's
// `AbortSignal.any([timeoutSignal, callerSignal])` and rejects the in-flight
// `await fetchImpl(...)` with an AbortError. Audit safety is independently
// guaranteed by the worker-side `bridge.clearRunActive()` gate; the abort
// exists for worker-time fairness — guests that fire-and-forget fetch don't
// borrow up to 30s of the next run's worker time.
const handles = createRunScopedHandles<AbortController>((controller) => {
	controller.abort();
});

/**
 * Translate any throw originating from `hardenedFetch` (or a test-only
 * `fetchImpl` override) into a `FetchError` carrying a curated `reason`
 * enum. See `openspec/specs/sandbox-stdlib/spec.md` "FetchError shape for
 * `$fetch/do` failures" for the translation table.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive translation table — one branch per HostBlockedError.reason and per Error subclass — collapsing it would hide the per-case mapping
function translateFetchError(err: unknown, url: string): FetchError {
	if (err instanceof FetchError) {
		return err;
	}
	if (err instanceof HostBlockedError) {
		switch (err.reason) {
			case "bad-scheme":
				return new FetchError({ reason: "bad-scheme", url });
			case "private-ip":
			case "redirect-to-private":
				return new FetchError({ reason: "private-address", url });
			case "zone-id":
				return new FetchError({ reason: "private-address", url });
			default:
				return new FetchError({ reason: "network-error", url });
		}
	}
	if (err instanceof TypeError) {
		const msg = err.message;
		if (msg.startsWith("invalid URL") || msg.startsWith("invalid redirect")) {
			return new FetchError({ reason: "invalid-url", url });
		}
	}
	if (err instanceof Error) {
		const name = err.name;
		const code = (err as { code?: unknown }).code;
		const codeStr = typeof code === "string" ? code : undefined;
		if (name === "AbortError" || name === "TimeoutError") {
			return new FetchError({ reason: "aborted", url });
		}
		if (err.message.includes("redirect chain exceeded")) {
			return new FetchError({ reason: "redirect-loop", url });
		}
		return new FetchError(
			codeStr === undefined
				? { reason: "network-error", url }
				: { reason: "network-error", url, code: codeStr },
		);
	}
	return new FetchError({ reason: "network-error", url });
}

async function dispatchFetch(
	args: DispatchFetchArgs,
): Promise<FetchResponseWire> {
	const { fetchImpl, method, url, headers, body } = args;
	const controller = handles.track(new AbortController());
	try {
		try {
			const response = await fetchImpl(url, {
				method,
				headers,
				body,
				signal: controller.signal,
			});
			const outHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				outHeaders[k] = v;
			});
			return {
				status: response.status,
				statusText: response.statusText,
				headers: outHeaders,
				body: await response.text(),
			};
		} catch (err) {
			throw translateFetchError(err, url);
		}
	} finally {
		await handles.release(controller);
	}
}

/**
 * Private `$fetch/do` dispatcher; the web-platform polyfill captures it
 * and installs `globalThis.fetch`. The production path unconditionally
 * closes over `hardenedFetch` (SSRF-resistant: IANA blocklist + DNS
 * validation + redirect re-check + 30s timeout); the only opt-out is a
 * full plugin replacement via `__pluginLoaderOverride`, a test-only
 * escape hatch. This preserves "hardened by default" structurally.
 */
const name = "fetch";
const dependsOn: readonly string[] = ["web-platform"];

/**
 * Build the `$fetch/do` dispatcher descriptor closing over the supplied
 * `FetchImpl`. Exposed as a named export so unit tests can construct a
 * descriptor with a mock fetch without going through the full plugin-
 * loader pipeline; production `worker()` always passes `hardenedFetch`.
 */
function fetchDispatcherDescriptor(
	fetchImpl: FetchImpl,
): GuestFunctionDescription {
	return {
		name: FETCH_DISPATCHER_NAME,
		// Guest-facing alias used by the bridge-closure rule for the
		// `fetch failed: …` message prefix and the `<bridge:fetch>`
		// synthetic stack frame on error paths.
		publicName: "fetch",
		args: [Guest.string(), Guest.string(), Guest.object(), Guest.raw()],
		result: Guest.object(),
		handler: ((
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) =>
			dispatchFetch({
				fetchImpl,
				method,
				url,
				headers,
				body,
			})) as unknown as GuestFunctionDescription["handler"],
		log: { request: "system" },
		// Surface `<METHOD> <url>` in the event `name` field so the flamegraph
		// and audit log show "GET https://example.com/x" rather than the
		// bridge-internal descriptor identifier ("$fetch/do"). The `system.*`
		// prefix consolidation means the operation kind ("fetch") is conveyed
		// via the name's prefix; the URL/method follow.
		logName: (args) =>
			`fetch ${String(args[0] ?? "GET")} ${String(args[1] ?? "")}`,
		// The raw args tuple `[method, url, headers, body]` is already the
		// right shape for the audit event — omit the logInput override.
		public: false,
	};
}

function worker(_ctx: PluginContext): PluginSetup {
	return {
		guestFunctions: [fetchDispatcherDescriptor(hardenedFetch)],
		onRunFinished: handles.drain,
	};
}

export type { FetchImpl, FetchResponseWire };
export {
	dependsOn,
	FETCH_DISPATCHER_NAME,
	fetchDispatcherDescriptor,
	name,
	worker,
};
