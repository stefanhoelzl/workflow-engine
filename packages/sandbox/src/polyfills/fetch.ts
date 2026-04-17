// fetch shim — routes through the __hostFetch bridge. Must evaluate AFTER
// bridgeHostFetch() has installed __hostFetch on globalThis.
//
// Capture-and-delete pattern: __hostFetch is captured into the module's
// closure at eval time (becomes the IIFE closure in the bundled output),
// then the global is deleted so guest code cannot read or overwrite the
// raw host bridge. Required by CLAUDE.md §2 rule.

const _hostFetch = (
	globalThis as unknown as {
		__hostFetch: (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<unknown>;
	}
).__hostFetch;

function normalizeHeaders(
	init: HeadersInit | undefined,
): Record<string, string> {
	if (!init) {
		return {};
	}
	if (typeof Headers !== "undefined" && init instanceof Headers) {
		const obj: Record<string, string> = {};
		init.forEach((v, k) => {
			obj[k] = v;
		});
		return obj;
	}
	if (Array.isArray(init)) {
		return Object.fromEntries(init);
	}
	return { ...(init as Record<string, string>) };
}

function normalizeBody(body: unknown): string | null {
	if (body == null) {
		return null;
	}
	if (typeof body === "string") {
		return body;
	}
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		return new TextDecoder().decode(body as ArrayBuffer | ArrayBufferView);
	}
	if (
		typeof URLSearchParams !== "undefined" &&
		body instanceof URLSearchParams
	) {
		return body.toString();
	}
	return String(body);
}

interface HostResponse {
	status: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string;
	url?: string;
}

function makeResponse(hostRes: HostResponse): Response {
	const status = hostRes.status;
	const headers = new Headers(hostRes.headers || {});
	const body = hostRes.body == null ? "" : String(hostRes.body);
	let consumed = false;

	function consume(): string {
		if (consumed) {
			throw new TypeError("Body has already been consumed");
		}
		consumed = true;
		return body;
	}

	return {
		status,
		statusText: hostRes.statusText || "",
		ok: status >= 200 && status < 300,
		headers,
		url: hostRes.url || "",
		redirected: false,
		type: "basic",
		text() {
			return Promise.resolve(consume());
		},
		json() {
			try {
				return Promise.resolve(JSON.parse(consume()));
			} catch (e) {
				return Promise.reject(e);
			}
		},
		arrayBuffer() {
			return Promise.resolve(
				new TextEncoder().encode(consume()).buffer as ArrayBuffer,
			);
		},
	} as unknown as Response;
}

function fetchShim(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = typeof input === "string" ? input : String(input);
	const method = init?.method ?? "GET";
	const headers = normalizeHeaders(init?.headers);
	const body = normalizeBody(init?.body);
	return _hostFetch(method, url, headers, body).then(
		makeResponse as (r: unknown) => Response,
	);
}

Object.defineProperty(globalThis, "fetch", {
	value: fetchShim,
	writable: false,
	configurable: false,
	enumerable: true,
});

// Delete the raw bridge so guest code cannot read or overwrite it.
delete (globalThis as { __hostFetch?: unknown }).__hostFetch;
