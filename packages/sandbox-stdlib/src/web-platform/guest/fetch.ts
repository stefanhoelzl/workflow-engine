// fetch shim — routes through the fetch plugin's `$fetch/do` dispatcher.
// Must evaluate AFTER Phase-1c has installed guest functions on globalThis
// AND after request.ts/response.ts have installed Request/Response.
//
// Capture-and-delete pattern: `$fetch/do` is captured into the module's
// closure at eval time (becomes the IIFE closure in the bundled output),
// then Phase-3 private-descriptor deletion removes the global so guest
// code cannot read or overwrite the raw host bridge. Required by
// SECURITY.md §2 R-2 (locked internals).
//
// Body and AbortSignal:
//   - Request bodies are drained to a string before crossing the host
//     bridge — the wire is `$fetch/do(method, url, headers, body|null)`.
//     Streaming bodies and binary bodies are decoded as UTF-8 (the
//     existing host signature carries no binary channel; expanding it
//     is a separate change).
//   - Request.signal is stored on the Request per spec but NOT plumbed
//     to the bridge in this PR. See /SECURITY.md §2.

import { makeNetworkResponse } from "./response.js";

// `$fetch/do` is not a valid JS identifier — capture via bracket access.
// The fetch plugin registers this descriptor as private (`public: false`),
// so Phase-3 will delete it; the closure below holds the reference.
const _hostFetch = (globalThis as unknown as Record<string, unknown>)[
	"$fetch/do"
] as (
	method: string,
	url: string,
	headers: Record<string, string>,
	body: string | null,
) => Promise<unknown>;

function headersToObject(h: Headers): Record<string, string> {
	const obj: Record<string, string> = {};
	h.forEach((v, k) => {
		obj[k] = v;
	});
	return obj;
}

interface HostResponse {
	status: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string;
	url?: string;
}

interface NormalizedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

function buildRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	// fetch(req, init): per spec, init applied on top creates a new Request.
	// The Request copy-constructor handles this; passing the URL string
	// covers the (string|URL) branch via the same code path.
	if (input instanceof Request) {
		const hasInit = init && Object.keys(init).length > 0;
		return hasInit ? new Request(input, init) : input;
	}
	const url = typeof input === "string" ? input : String(input);
	return new Request(url, init);
}

async function normalize(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<NormalizedRequest> {
	const req = buildRequest(input, init);
	const text = req.bodyUsed ? "" : await req.text();
	return {
		url: req.url,
		method: req.method,
		headers: headersToObject(req.headers),
		body: text === "" ? null : text,
	};
}

async function fetchShim(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const { url, method, headers, body } = await normalize(input, init);
	const hostRes = (await _hostFetch(
		method,
		url,
		headers,
		body,
	)) as HostResponse;
	return makeNetworkResponse(hostRes.body ?? "", {
		status: hostRes.status,
		statusText: hostRes.statusText ?? "",
		headers: hostRes.headers ?? {},
		url: hostRes.url ?? url,
		redirected: false,
		type: "basic",
	}) as unknown as Response;
}

Object.defineProperty(globalThis, "fetch", {
	value: fetchShim,
	writable: false,
	configurable: false,
	enumerable: true,
});

// Phase-3 of the plugin-boot pipeline deletes `$fetch/do` automatically
// because the descriptor is `public: false`. Nothing to do here.
