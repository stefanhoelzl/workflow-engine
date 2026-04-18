// Response polyfill — replaces the previous duck-typed object literal
// in fetch.ts with a real, constructible class. Pure JS, no host bridge.
//
// Spec coverage is the WHATWG Fetch §Response interface minus
// network-internal flags (the sandbox has no concept of "redirected from
// a CORS context" etc.). Body handling is delegated to body-mixin.ts.

import { type BodyInit, BodyState, extractBody } from "./body-mixin.js";

interface ResponseInit {
	status?: number;
	statusText?: string;
	headers?: HeadersInit;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const RESPONSE_STATE = new WeakMap<
	Response,
	{
		status: number;
		statusText: string;
		headers: Headers;
		body: BodyState;
		url: string;
		type: ResponseType;
		redirected: boolean;
	}
>();

class Response {
	constructor(body: BodyInit = null, init: ResponseInit = {}) {
		const status = init.status ?? 200;
		if (status < 200 || status > 599) {
			throw new RangeError(`Response status ${status} out of range`);
		}
		const statusText = init.statusText ?? "";
		const headers = new Headers(init.headers || {});

		if (body !== null && body !== undefined && NULL_BODY_STATUSES.has(status)) {
			throw new TypeError(
				`Response with null-body status ${status} cannot have a body`,
			);
		}

		const extracted = extractBody(body);
		if (extracted.contentType !== null && !headers.has("content-type")) {
			headers.set("content-type", extracted.contentType);
		}

		RESPONSE_STATE.set(this, {
			status,
			statusText,
			headers,
			body: new BodyState(extracted),
			url: "",
			type: "default",
			redirected: false,
		});
	}

	get status(): number {
		return state(this).status;
	}
	get statusText(): string {
		return state(this).statusText;
	}
	get ok(): boolean {
		const s = state(this).status;
		return s >= 200 && s < 300;
	}
	get headers(): Headers {
		return state(this).headers;
	}
	get url(): string {
		return state(this).url;
	}
	get type(): ResponseType {
		return state(this).type;
	}
	get redirected(): boolean {
		return state(this).redirected;
	}
	get body(): ReadableStream<Uint8Array> | null {
		return state(this).body.body;
	}
	get bodyUsed(): boolean {
		return state(this).body.bodyUsed;
	}

	text(): Promise<string> {
		return state(this).body.text();
	}
	json(): Promise<unknown> {
		return state(this).body.json();
	}
	arrayBuffer(): Promise<ArrayBuffer> {
		return state(this).body.arrayBuffer();
	}
	bytes(): Promise<Uint8Array> {
		return state(this).body.bytes();
	}
	blob(): Promise<Blob> {
		return state(this).body.blob();
	}
	formData(): Promise<FormData> {
		const ct = state(this).headers.get("content-type");
		return state(this).body.formData(ct);
	}

	clone(): Response {
		const s = state(this);
		const cloned = Object.create(Response.prototype) as Response;
		RESPONSE_STATE.set(cloned, {
			status: s.status,
			statusText: s.statusText,
			headers: new Headers(s.headers),
			body: s.body.clone(),
			url: s.url,
			type: s.type,
			redirected: s.redirected,
		});
		return cloned;
	}

	static error(): Response {
		const r = new Response(null, { status: 200, statusText: "" });
		const s = state(r);
		s.type = "error";
		(s as { status: number }).status = 0;
		return r;
	}

	static redirect(url: string | URL, status = 302): Response {
		if (!REDIRECT_STATUSES.has(status)) {
			throw new RangeError(`Invalid redirect status ${status}`);
		}
		const target =
			typeof url === "string" ? new URL(url).toString() : url.toString();
		const r = new Response(null, { status });
		state(r).headers.set("location", target);
		return r;
	}

	static json(data: unknown, init: ResponseInit = {}): Response {
		const body = JSON.stringify(data);
		if (body === undefined) {
			throw new TypeError("Response.json: data is not serializable");
		}
		const headers = new Headers(init.headers || {});
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		return new Response(body, { ...init, headers });
	}
}

function state(r: Response) {
	const s = RESPONSE_STATE.get(r);
	if (!s) {
		throw new TypeError("Illegal invocation");
	}
	return s;
}

// Internal helper for fetch.ts: construct a Response and stamp the
// network-derived url/type/redirected flags (not exposed to constructor
// per spec — those are owned by fetch's internal "create a Response").
function makeNetworkResponseImpl(
	body: BodyInit,
	init: ResponseInit & {
		url?: string;
		redirected?: boolean;
		type?: ResponseType;
	},
): Response {
	const r = new Response(body, init);
	const s = state(r);
	if (init.url !== undefined) {
		s.url = init.url;
	}
	if (init.redirected !== undefined) {
		s.redirected = init.redirected;
	}
	if (init.type !== undefined) {
		s.type = init.type;
	}
	return r;
}

Object.defineProperty(globalThis, "Response", {
	value: Response,
	writable: true,
	configurable: true,
	enumerable: true,
});

export const makeNetworkResponse = makeNetworkResponseImpl;
