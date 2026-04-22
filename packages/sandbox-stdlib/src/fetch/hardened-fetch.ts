// Host-side hardened fetch: closes the app-layer SSRF gap for sandbox
// outbound HTTP. See openspec/specs/sandbox/spec.md §Hardened outbound fetch
// and SECURITY.md §2 R-S4.
//
// Pipeline per request (initial URL and every redirect hop):
//   0. `data:` URLs short-circuit via undici's native handler — no DNS,
//      no socket, no exfiltration vector (the URL IS the response body)
//   1. scheme allowlist (http / https; any port)
//   2. dns.lookup(host, {all: true}) → full A + AAAA set
//   3. unwrap IPv4-mapped IPv6, reject IPv6 zone identifiers
//   4. IANA special-use blocklist — fail-closed if ANY address is blocked
//   5. TCP connect to the validated IP, servername = original host (SNI)
//   6. manual redirect follow, cap 5, Authorization stripped cross-origin
//   7. 30s total wall-clock cap composed with caller's signal

import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import {
	Agent,
	buildConnector,
	type Dispatcher,
	request,
	fetch as undiciFetch,
} from "undici";

type BlockReason =
	| "bad-scheme"
	| "private-ip"
	| "redirect-to-private"
	| "zone-id";

class FetchBlockedError extends Error {
	readonly reason: BlockReason;
	constructor(reason: BlockReason, message: string) {
		super(message);
		this.name = "FetchBlockedError";
		this.reason = reason;
	}
}

// IANA special-use CIDRs — explicit list so the spec and code match by
// inspection. Any change here requires updating the spec scenario in
// openspec/specs/sandbox/spec.md §Hardened outbound fetch and SECURITY.md §2.
const BLOCKED_CIDRS_IPV4: readonly string[] = [
	"0.0.0.0/8", // unspecified / "this network"
	"10.0.0.0/8", // RFC1918 private
	"100.64.0.0/10", // CGNAT
	"127.0.0.0/8", // loopback
	"169.254.0.0/16", // link-local / cloud metadata
	"172.16.0.0/12", // RFC1918 private
	"192.0.0.0/24", // IETF protocol assignments
	"192.0.2.0/24", // TEST-NET-1
	"192.88.99.0/24", // 6to4 relay
	"192.168.0.0/16", // RFC1918 private
	"198.18.0.0/15", // benchmark
	"198.51.100.0/24", // TEST-NET-2
	"203.0.113.0/24", // TEST-NET-3
	"224.0.0.0/4", // multicast
	"240.0.0.0/4", // reserved (future use)
	"255.255.255.255/32", // limited broadcast
];

const BLOCKED_CIDRS_IPV6: readonly string[] = [
	"::/128", // unspecified
	"::1/128", // loopback
	"100::/64", // discard-only prefix
	"fc00::/7", // unique-local addresses (ULA)
	"fe80::/10", // link-local
];

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

const PARSED_IPV4_CIDRS: readonly Cidr[] = BLOCKED_CIDRS_IPV4.map((c) =>
	ipaddr.parseCIDR(c),
);
const PARSED_IPV6_CIDRS: readonly Cidr[] = BLOCKED_CIDRS_IPV6.map((c) =>
	ipaddr.parseCIDR(c),
);

function isBlockedAddress(addrStr: string): boolean {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(addrStr);
	} catch {
		// An unparseable address is refused rather than allowed.
		return true;
	}
	// Unwrap IPv4-mapped IPv6 and re-classify as IPv4.
	if (parsed.kind() === "ipv6") {
		const v6 = parsed as ipaddr.IPv6;
		if (v6.isIPv4MappedAddress()) {
			parsed = v6.toIPv4Address();
		}
	}
	if (parsed.kind() === "ipv4") {
		const v4 = parsed as ipaddr.IPv4;
		for (const cidr of PARSED_IPV4_CIDRS) {
			if (v4.match(cidr as [ipaddr.IPv4, number])) {
				return true;
			}
		}
		return false;
	}
	const v6 = parsed as ipaddr.IPv6;
	for (const cidr of PARSED_IPV6_CIDRS) {
		if (v6.match(cidr as [ipaddr.IPv6, number])) {
			return true;
		}
	}
	return false;
}

// URL parsing preserves zone identifiers inside brackets — `new URL("http://
// [fe80::1%eth0]/")` parses with hostname `"[fe80::1%25eth0]"`. Treat any
// percent inside the bracketed literal as a zone id.
function hasZoneIdentifier(hostname: string): boolean {
	return hostname.includes("%");
}

async function assertHostIsPublic(hostname: string): Promise<string> {
	if (hasZoneIdentifier(hostname)) {
		throw new FetchBlockedError(
			"zone-id",
			"IPv6 zone identifiers are not permitted",
		);
	}
	// Strip IPv6 brackets for dns.lookup (`[::1]` → `::1`).
	const bare =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	const addresses = await dnsLookup(bare, { all: true });
	if (addresses.length === 0) {
		throw new Error(`dns.lookup returned no addresses for ${hostname}`);
	}
	for (const entry of addresses) {
		if (isBlockedAddress(entry.address)) {
			throw new FetchBlockedError(
				"private-ip",
				`${hostname} resolves to a blocked address`,
			);
		}
	}
	const first = addresses[0];
	if (!first) {
		throw new Error(`dns.lookup returned empty list for ${hostname}`);
	}
	return first.address;
}

// Undici connector: resolves + validates, then hands the base connector a
// pre-resolved IP so no second DNS lookup occurs between validation and
// socket open.
function makeConnector(): ReturnType<typeof buildConnector> {
	const base = buildConnector({});
	async function connectAsync(
		options: Parameters<ReturnType<typeof buildConnector>>[0],
		callback: Parameters<ReturnType<typeof buildConnector>>[1],
	): Promise<void> {
		const originalHostname = options.hostname;
		try {
			const chosen = await assertHostIsPublic(originalHostname);
			base(
				{
					...options,
					hostname: chosen,
					servername: options.servername ?? originalHostname,
				},
				callback,
			);
		} catch (err) {
			callback(err instanceof Error ? err : new Error(String(err)), null);
		}
	}
	return (options, callback) => {
		connectAsync(options, callback).catch((err: unknown) => {
			callback(err instanceof Error ? err : new Error(String(err)), null);
		});
	};
}

let cachedAgent: Agent | undefined;

function getAgent(): Dispatcher {
	if (cachedAgent === undefined) {
		cachedAgent = new Agent({ connect: makeConnector() });
	}
	return cachedAgent;
}

const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 30_000;
const MAX_CAUSE_DEPTH = 8;
const HTTP_STATUS_REDIRECT_MIN = 300;
const HTTP_STATUS_REDIRECT_MAX = 400;
const HTTP_STATUS_MOVED_PERMANENTLY = 301;
const HTTP_STATUS_FOUND = 302;
const HTTP_STATUS_SEE_OTHER = 303;

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	if (!headers) {
		return {};
	}
	const h = new Headers(headers);
	const out: Record<string, string> = {};
	h.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

function bodyFromInit(init?: RequestInit): string | null {
	if (init?.body === undefined || init.body === null) {
		return null;
	}
	if (typeof init.body === "string") {
		return init.body;
	}
	// Body types other than string are not carried across the QuickJS bridge
	// in this revision — the guest-side fetch shim already drains bodies to
	// string before forwarding. Callers that somehow pass a non-string body
	// get stringified here to avoid crashing the pipeline.
	return String(init.body);
}

function unwrapFetchBlocked(err: unknown): FetchBlockedError | null {
	let cursor: unknown = err;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor; depth += 1) {
		if (cursor instanceof FetchBlockedError) {
			return cursor;
		}
		cursor = (cursor as { cause?: unknown }).cause;
	}
	return null;
}

function extractLocation(
	headers: Record<string, string | string[] | undefined>,
): string | null {
	const raw = headers.location;
	if (raw === undefined) {
		return null;
	}
	return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

function responseFromUndici(
	statusCode: number,
	headers: Record<string, string | string[] | undefined>,
	bodyText: string,
	finalUrl: string,
): Response {
	// undici's headers include arrays for repeated headers; append each so the
	// resulting `Headers` preserves duplicates (matches native fetch behaviour).
	const init: { status: number; statusText?: string; headers: Headers } = {
		status: statusCode,
		headers: new Headers(),
	};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const v of value) {
				init.headers.append(key, v);
			}
		} else {
			init.headers.set(key, value);
		}
	}
	const res = new Response(bodyText, {
		status: statusCode,
		headers: init.headers,
	});
	// `Response.url` is read-only via the constructor; callers that care
	// about the final URL should inspect the `Content-Location` header or
	// be aware that guest-visible `redirected` flags are not forwarded in
	// this revision (see polyfill fetch shim in polyfills/fetch.ts).
	Object.defineProperty(res, "url", { value: finalUrl, configurable: true });
	return res;
}

function normalizeInputUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return (input as Request).url;
}

function composeSignal(
	callerSignal: AbortSignal | null | undefined,
): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
	if (!callerSignal) {
		return timeoutSignal;
	}
	return AbortSignal.any([timeoutSignal, callerSignal]);
}

function stripHeader(
	headers: Record<string, string>,
	lowerName: string,
): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== lowerName) {
			filtered[key] = value;
		}
	}
	return filtered;
}

function validateScheme(parsed: URL): void {
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new FetchBlockedError(
			"bad-scheme",
			`unsupported scheme: ${parsed.protocol}`,
		);
	}
}

function parseUrlOrThrow(currentUrl: string): URL {
	try {
		return new URL(currentUrl);
	} catch {
		// Invalid URL is a caller error, not a policy block — classify as
		// a generic TypeError that the handler will surface as
		// `reason: "network-error"`.
		throw new TypeError(`invalid URL: ${currentUrl}`);
	}
}

interface FetchState {
	currentUrl: string;
	currentMethod: string;
	currentHeaders: Record<string, string>;
	currentBody: string | null;
}

function applyRedirect(
	state: FetchState,
	statusCode: number,
	location: string,
	prevParsed: URL,
): FetchState {
	let nextUrl: string;
	try {
		nextUrl = new URL(location, state.currentUrl).toString();
	} catch {
		throw new FetchBlockedError(
			"bad-scheme",
			`invalid redirect target: ${location}`,
		);
	}
	const nextParsed = new URL(nextUrl);
	let headers = state.currentHeaders;
	// Strip Authorization on cross-origin redirect.
	if (nextParsed.origin !== prevParsed.origin) {
		headers = stripHeader(headers, "authorization");
	}
	let method = state.currentMethod;
	let body = state.currentBody;
	// 301/302/303 with a non-idempotent method downgrade to GET and drop body.
	// 307/308 preserve method and body per spec. We approximate by also
	// dropping the body on 301/302 matching browser/Node behaviour.
	if (
		statusCode === HTTP_STATUS_MOVED_PERMANENTLY ||
		statusCode === HTTP_STATUS_FOUND ||
		statusCode === HTTP_STATUS_SEE_OTHER
	) {
		if (method !== "GET" && method !== "HEAD") {
			method = "GET";
		}
		body = null;
		headers = stripHeader(headers, "content-length");
	}
	return {
		currentUrl: nextUrl,
		currentMethod: method,
		currentHeaders: headers,
		currentBody: body,
	};
}

async function issueHopRequest(
	state: FetchState,
	signal: AbortSignal,
	hop: number,
): Promise<Awaited<ReturnType<typeof request>>> {
	try {
		return await request(state.currentUrl, {
			method: state.currentMethod as Dispatcher.HttpMethod,
			headers: state.currentHeaders,
			body: state.currentBody,
			dispatcher: getAgent(),
			signal,
		});
	} catch (err) {
		const blocked = unwrapFetchBlocked(err);
		if (blocked) {
			// Past the initial hop, a "private-ip" reason is really a
			// redirect-to-private event — re-wrap so the handler observes
			// the more specific classification.
			if (hop > 0 && blocked.reason === "private-ip") {
				throw new FetchBlockedError(
					"redirect-to-private",
					`redirect target ${state.currentUrl} resolves to a blocked address`,
				);
			}
			throw blocked;
		}
		throw err;
	}
}

// `data:` URLs have no network component — the URL is the payload per
// RFC 2397. Undici's `fetch()` handles them natively (base64 decoding,
// content-type parsing, 200 OK response). There is no SSRF vector (no DNS,
// no socket) and no exfiltration vector (data flows INTO the guest only).
async function fetchDataUrl(
	url: string,
	method: string | undefined,
	signal: AbortSignal,
): Promise<Response> {
	const dataInit: { method?: string; signal?: AbortSignal } = { signal };
	if (method) {
		dataInit.method = method;
	}
	// undici's Response is structurally the Node built-in Response at
	// runtime; the types diverge only in node_modules package shape.
	const res = await undiciFetch(url, dataInit);
	return res as unknown as Response;
}

async function hardenedFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const signal = composeSignal(init?.signal);
	const initialUrl = normalizeInputUrl(input);

	if (initialUrl.toLowerCase().startsWith("data:")) {
		return fetchDataUrl(initialUrl, init?.method, signal);
	}

	let state: FetchState = {
		currentUrl: initialUrl,
		currentMethod: (init?.method ?? "GET").toUpperCase(),
		currentHeaders: headersToRecord(init?.headers),
		currentBody: bodyFromInit(init),
	};

	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		const parsed = parseUrlOrThrow(state.currentUrl);
		validateScheme(parsed);

		// biome-ignore lint/performance/noAwaitInLoops: redirect hops are inherently sequential — each hop's URL comes from the previous hop's Location header
		const response = await issueHopRequest(state, signal, hop);
		const { statusCode, headers, body } = response;

		if (
			statusCode >= HTTP_STATUS_REDIRECT_MIN &&
			statusCode < HTTP_STATUS_REDIRECT_MAX
		) {
			const location = extractLocation(headers);
			if (!location) {
				const text = await body.text();
				return responseFromUndici(statusCode, headers, text, state.currentUrl);
			}
			await body.text();
			if (hop >= MAX_REDIRECTS) {
				throw new FetchBlockedError(
					"redirect-to-private",
					`redirect chain exceeded ${MAX_REDIRECTS} hops`,
				);
			}
			state = applyRedirect(state, statusCode, location, parsed);
			continue;
		}

		const text = await body.text();
		return responseFromUndici(statusCode, headers, text, state.currentUrl);
	}
	// Unreachable — the for-loop either returns or throws.
	throw new FetchBlockedError(
		"redirect-to-private",
		`redirect chain exceeded ${MAX_REDIRECTS} hops`,
	);
}

export type { BlockReason };
export {
	BLOCKED_CIDRS_IPV4,
	BLOCKED_CIDRS_IPV6,
	FetchBlockedError,
	hardenedFetch,
	hasZoneIdentifier,
	isBlockedAddress,
};
