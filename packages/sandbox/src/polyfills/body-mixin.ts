// Body mixin for Request and Response.
//
// Internal module — not installed on globalThis. Exports `extractBody`
// (normalizes any BodyInit to a Blob + content-type per spec) and
// `BodyState` (storage + the seven body-reading methods that both
// Request and Response forward to).
//
// All actual byte storage lives in fetch-blob's Blob (already on
// globalThis); the mixin is a thin wrapper around that.

import { formDataToBlob } from "formdata-polyfill/esm.min.js";

export type BodyInit =
	| string
	| Blob
	| FormData
	| URLSearchParams
	| ArrayBuffer
	| ArrayBufferView
	| ReadableStream<Uint8Array>
	| null
	| undefined;

export interface ExtractedBody {
	blob: Blob | null;
	stream: ReadableStream<Uint8Array> | null;
	contentType: string | null;
}

// Per WHATWG Fetch §extract a body. Returns the body (as a Blob for
// in-memory sources, or a ReadableStream passthrough) and the implicit
// Content-Type the source dictates (caller may override via init.headers).
export function extractBody(input: BodyInit): ExtractedBody {
	if (input == null) {
		return { blob: null, stream: null, contentType: null };
	}
	if (typeof input === "string") {
		return {
			blob: new Blob([input], { type: "text/plain;charset=UTF-8" }),
			stream: null,
			contentType: "text/plain;charset=UTF-8",
		};
	}
	if (input instanceof URLSearchParams) {
		return {
			blob: new Blob([input.toString()], {
				type: "application/x-www-form-urlencoded;charset=UTF-8",
			}),
			stream: null,
			contentType: "application/x-www-form-urlencoded;charset=UTF-8",
		};
	}
	if (input instanceof FormData) {
		const blob = formDataToBlob(input) as Blob;
		return { blob, stream: null, contentType: blob.type };
	}
	if (input instanceof Blob) {
		return { blob: input, stream: null, contentType: input.type || null };
	}
	if (input instanceof ArrayBuffer) {
		return {
			blob: new Blob([new Uint8Array(input)]),
			stream: null,
			contentType: null,
		};
	}
	if (ArrayBuffer.isView(input)) {
		const view = input as ArrayBufferView;
		const copy = new Uint8Array(
			view.buffer.slice(
				view.byteOffset,
				view.byteOffset + view.byteLength,
			) as ArrayBuffer,
		);
		return { blob: new Blob([copy]), stream: null, contentType: null };
	}
	if (input instanceof ReadableStream) {
		return { blob: null, stream: input, contentType: null };
	}
	// Spec fallback: stringify
	return {
		blob: new Blob([String(input)], { type: "text/plain;charset=UTF-8" }),
		stream: null,
		contentType: "text/plain;charset=UTF-8",
	};
}

// Internal state for the body mixin. Stored per-instance on Request/Response.
export class BodyState {
	#blob: Blob | null;
	#stream: ReadableStream<Uint8Array> | null;
	#bodyUsed = false;

	constructor(extracted: ExtractedBody) {
		this.#blob = extracted.blob;
		this.#stream = extracted.stream;
	}

	get bodyUsed(): boolean {
		return this.#bodyUsed;
	}

	// Lazily expose the body as a ReadableStream. For in-memory Blob
	// bodies, defer to Blob.stream() so callers see a real stream.
	get body(): ReadableStream<Uint8Array> | null {
		if (this.#stream !== null) {
			return this.#stream;
		}
		if (this.#blob !== null) {
			// Cache the stream so repeated accesses return the same instance
			// (per spec — a single body is exposed once and locks on tee/read).
			const stream = this.#blob.stream() as ReadableStream<Uint8Array>;
			this.#stream = stream;
			this.#blob = null;
			return stream;
		}
		return null;
	}

	#consume(): void {
		if (this.#bodyUsed) {
			throw new TypeError("Body has already been consumed");
		}
		this.#bodyUsed = true;
	}

	async text(): Promise<string> {
		this.#consume();
		if (this.#blob !== null) {
			return this.#blob.text();
		}
		if (this.#stream !== null) {
			const buf = await this.#drainStream();
			return new TextDecoder().decode(buf);
		}
		return "";
	}

	async json(): Promise<unknown> {
		const text = await this.text();
		return JSON.parse(text);
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		this.#consume();
		if (this.#blob !== null) {
			return this.#blob.arrayBuffer();
		}
		if (this.#stream !== null) {
			const buf = await this.#drainStream();
			return buf.buffer.slice(
				buf.byteOffset,
				buf.byteOffset + buf.byteLength,
			) as ArrayBuffer;
		}
		return new ArrayBuffer(0);
	}

	async bytes(): Promise<Uint8Array> {
		const ab = await this.arrayBuffer();
		return new Uint8Array(ab);
	}

	async blob(): Promise<Blob> {
		this.#consume();
		if (this.#blob !== null) {
			return this.#blob;
		}
		if (this.#stream !== null) {
			const buf = await this.#drainStream();
			return new Blob([buf as Uint8Array<ArrayBuffer>]);
		}
		return new Blob([]);
	}

	// Parses application/x-www-form-urlencoded bodies into a FormData.
	// Multipart parsing is not implemented — callers that pass multipart
	// content-types get a TypeError matching the spec's "could not parse"
	// rejection but with a clearer reason.
	async formData(contentType: string | null): Promise<FormData> {
		const ct = (contentType || "").toLowerCase();
		const text = await this.text();
		const fd = new FormData();
		if (ct.startsWith("application/x-www-form-urlencoded")) {
			const params = new URLSearchParams(text);
			for (const [k, v] of params) {
				fd.append(k, v);
			}
			return fd;
		}
		if (ct.startsWith("multipart/form-data")) {
			throw new TypeError(
				"Body.formData(): multipart parsing is not implemented in the sandbox",
			);
		}
		throw new TypeError(
			`Body.formData(): unsupported content-type "${contentType ?? ""}"`,
		);
	}

	async #drainStream(): Promise<Uint8Array> {
		const stream = this.#stream;
		if (stream === null) {
			return new Uint8Array(0);
		}
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		let done = false;
		while (!done) {
			// biome-ignore lint/performance/noAwaitInLoops: ReadableStream pulls are inherently sequential
			const r = await reader.read();
			done = r.done;
			if (r.value) {
				chunks.push(r.value);
				total += r.value.byteLength;
			}
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}

	clone(): BodyState {
		if (this.#bodyUsed) {
			throw new TypeError("Cannot clone a body that has already been consumed");
		}
		if (this.#stream !== null) {
			throw new TypeError("Cannot clone a stream-backed body in the sandbox");
		}
		return new BodyState({
			blob: this.#blob,
			stream: null,
			contentType: null,
		});
	}
}
