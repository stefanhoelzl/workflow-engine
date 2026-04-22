// Request polyfill — hand-rolled WHATWG Fetch §Request class.
// Pure JS, no host bridge. Body handling is delegated to body-mixin.ts.
//
// Intentional scope cuts:
//   - `signal` is stored per spec but NOT propagated into __hostFetch
//     in this PR — see /SECURITY.md §2 and the fetch.ts shim.
//   - CORS/credentials/cache/redirect/mode/integrity are stored as
//     defaults per spec but have no enforcement effect (the host bridge
//     ignores them; sandbox has no concept of origin).

import { type BodyInit, BodyState, extractBody } from "./body-mixin.js";

const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
const NORMALIZE_METHODS = new Set([
	"DELETE",
	"GET",
	"HEAD",
	"OPTIONS",
	"POST",
	"PUT",
]);

function normalizeMethod(m: string): string {
	const upper = m.toUpperCase();
	if (FORBIDDEN_METHODS.has(upper)) {
		throw new TypeError(`Forbidden method "${m}"`);
	}
	if (NORMALIZE_METHODS.has(upper)) {
		return upper;
	}
	return m;
}

interface RequestInitLike {
	method?: string;
	headers?: HeadersInit;
	body?: BodyInit;
	signal?: AbortSignal | null;
	mode?: RequestMode;
	credentials?: RequestCredentials;
	cache?: RequestCache;
	redirect?: RequestRedirect;
	referrer?: string;
	referrerPolicy?: ReferrerPolicy;
	integrity?: string;
	keepalive?: boolean;
	// fetch's `duplex: "half"` for streaming bodies. Stored only.
	duplex?: "half";
	window?: null;
}

const REQUEST_STATE = new WeakMap<
	Request,
	{
		url: string;
		method: string;
		headers: Headers;
		body: BodyState;
		signal: AbortSignal;
		mode: RequestMode;
		credentials: RequestCredentials;
		cache: RequestCache;
		redirect: RequestRedirect;
		referrer: string;
		referrerPolicy: ReferrerPolicy;
		integrity: string;
		keepalive: boolean;
		destination: RequestDestination;
		duplex: "half";
	}
>();

interface RequestSeed {
	url: string;
	method: string;
	headers: Headers;
	body: BodyInit;
	signal: AbortSignal;
	mode: RequestMode;
	credentials: RequestCredentials;
	cache: RequestCache;
	redirect: RequestRedirect;
	referrer: string;
	referrerPolicy: ReferrerPolicy;
	integrity: string;
	keepalive: boolean;
	duplex: "half";
}

function defaultSeed(input: string | URL): RequestSeed {
	const raw = typeof input === "string" ? input : input.toString();
	return {
		url: new URL(raw, "http://sandbox.invalid/").toString(),
		method: "GET",
		headers: new Headers(),
		body: null,
		signal: new AbortController().signal,
		mode: "cors",
		credentials: "same-origin",
		cache: "default",
		redirect: "follow",
		referrer: "about:client",
		referrerPolicy: "",
		integrity: "",
		keepalive: false,
		duplex: "half",
	};
}

function seedFromRequest(input: Request): RequestSeed {
	const s = REQUEST_STATE.get(input);
	if (!s) {
		throw new TypeError("Illegal invocation");
	}
	if (s.body.bodyUsed) {
		throw new TypeError("Cannot construct Request from a used Request");
	}
	return {
		url: s.url,
		method: s.method,
		headers: new Headers(s.headers),
		body: s.body.body,
		signal: s.signal,
		mode: s.mode,
		credentials: s.credentials,
		cache: s.cache,
		redirect: s.redirect,
		referrer: s.referrer,
		referrerPolicy: s.referrerPolicy,
		integrity: s.integrity,
		keepalive: s.keepalive,
		duplex: s.duplex,
	};
}

function applyInit(seed: RequestSeed, init: RequestInitLike): void {
	if (init.method !== undefined) {
		seed.method = normalizeMethod(init.method);
	}
	if (init.headers !== undefined) {
		seed.headers = new Headers(init.headers);
	}
	if (init.signal !== undefined && init.signal !== null) {
		seed.signal = init.signal;
	}
	if (init.mode !== undefined) {
		seed.mode = init.mode;
	}
	if (init.credentials !== undefined) {
		seed.credentials = init.credentials;
	}
	if (init.cache !== undefined) {
		seed.cache = init.cache;
	}
	if (init.redirect !== undefined) {
		seed.redirect = init.redirect;
	}
	if (init.referrer !== undefined) {
		seed.referrer = init.referrer;
	}
	if (init.referrerPolicy !== undefined) {
		seed.referrerPolicy = init.referrerPolicy;
	}
	if (init.integrity !== undefined) {
		seed.integrity = init.integrity;
	}
	if (init.keepalive !== undefined) {
		seed.keepalive = init.keepalive;
	}
	if (init.duplex !== undefined) {
		seed.duplex = init.duplex;
	}
	if (init.body !== undefined && init.body !== null) {
		seed.body = init.body;
	}
}

class Request {
	constructor(input: string | URL | Request, init: RequestInitLike = {}) {
		const seed =
			input instanceof Request ? seedFromRequest(input) : defaultSeed(input);
		applyInit(seed, init);

		if (
			seed.body !== null &&
			seed.body !== undefined &&
			(seed.method === "GET" || seed.method === "HEAD")
		) {
			throw new TypeError(
				`Request with method "${seed.method}" cannot have a body`,
			);
		}

		const extracted = extractBody(seed.body);
		if (extracted.contentType !== null && !seed.headers.has("content-type")) {
			seed.headers.set("content-type", extracted.contentType);
		}

		REQUEST_STATE.set(this, {
			url: seed.url,
			method: seed.method,
			headers: seed.headers,
			body: new BodyState(extracted),
			signal: seed.signal,
			mode: seed.mode,
			credentials: seed.credentials,
			cache: seed.cache,
			redirect: seed.redirect,
			referrer: seed.referrer,
			referrerPolicy: seed.referrerPolicy,
			integrity: seed.integrity,
			keepalive: seed.keepalive,
			destination: "",
			duplex: seed.duplex,
		});
	}

	get url(): string {
		return state(this).url;
	}
	get method(): string {
		return state(this).method;
	}
	get headers(): Headers {
		return state(this).headers;
	}
	get body(): ReadableStream<Uint8Array> | null {
		return state(this).body.body;
	}
	get bodyUsed(): boolean {
		return state(this).body.bodyUsed;
	}
	get signal(): AbortSignal {
		return state(this).signal;
	}
	get mode(): RequestMode {
		return state(this).mode;
	}
	get credentials(): RequestCredentials {
		return state(this).credentials;
	}
	get cache(): RequestCache {
		return state(this).cache;
	}
	get redirect(): RequestRedirect {
		return state(this).redirect;
	}
	get referrer(): string {
		return state(this).referrer;
	}
	get referrerPolicy(): ReferrerPolicy {
		return state(this).referrerPolicy;
	}
	get integrity(): string {
		return state(this).integrity;
	}
	get keepalive(): boolean {
		return state(this).keepalive;
	}
	get destination(): RequestDestination {
		return state(this).destination;
	}
	get duplex(): "half" {
		return state(this).duplex;
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

	clone(): Request {
		const s = state(this);
		const cloned = Object.create(Request.prototype) as Request;
		REQUEST_STATE.set(cloned, {
			...s,
			headers: new Headers(s.headers),
			body: s.body.clone(),
		});
		return cloned;
	}
}

function state(r: Request) {
	const s = REQUEST_STATE.get(r);
	if (!s) {
		throw new TypeError("Illegal invocation");
	}
	return s;
}

Object.defineProperty(globalThis, "Request", {
	value: Request,
	writable: true,
	configurable: true,
	enumerable: true,
});
