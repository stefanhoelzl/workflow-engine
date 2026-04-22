// CompressionStream / DecompressionStream polyfill (WHATWG Compression Streams).
// Pure-JS: wraps fflate's streaming classes in a TransformStream. No host
// bridge. All deflate/gzip/inflate work runs inside the QuickJS VM.
//
// Format → fflate class mapping per spec:
//   "gzip"         → Gzip / Gunzip    (RFC 1952)
//   "deflate"      → Zlib / Unzlib    (RFC 1950: zlib-wrapped deflate)
//   "deflate-raw"  → Deflate / Inflate (RFC 1951: raw deflate, no wrapper)

import { Deflate, Gunzip, Gzip, Inflate, Unzlib, Zlib } from "fflate";

type Format = "gzip" | "deflate" | "deflate-raw";
const FORMATS: ReadonlySet<string> = new Set<Format>([
	"gzip",
	"deflate",
	"deflate-raw",
]);

type StreamHandler = (data: Uint8Array, final: boolean) => void;
interface FflateCompressor {
	ondata: StreamHandler;
	push(chunk: Uint8Array, final?: boolean): void;
}
interface FflateDecompressor extends FflateCompressor {}

// WHATWG compression-streams input validation: chunks must be BufferSource
// (ArrayBuffer or ArrayBufferView). Non-BufferSource (null, numeric, plain
// objects, Arrays) must reject with TypeError. Views over SharedArrayBuffer
// are also rejected.
function toUint8Array(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) {
		if (isSharedBuffer(chunk.buffer)) {
			throw new TypeError("Input is backed by a SharedArrayBuffer");
		}
		return chunk;
	}
	if (ArrayBuffer.isView(chunk)) {
		const view = chunk as ArrayBufferView;
		if (isSharedBuffer(view.buffer)) {
			throw new TypeError("Input is backed by a SharedArrayBuffer");
		}
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	if (chunk instanceof ArrayBuffer) {
		return new Uint8Array(chunk);
	}
	if (isSharedBuffer(chunk)) {
		throw new TypeError("Input is a SharedArrayBuffer");
	}
	throw new TypeError(
		`CompressionStream/DecompressionStream: chunk must be a BufferSource, got ${describe(chunk)}`,
	);
}

function isSharedBuffer(buf: unknown): boolean {
	const SAB = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
	return typeof SAB === "function" && buf instanceof (SAB as new () => object);
}

function describe(v: unknown): string {
	if (v === null) {
		return "null";
	}
	if (Array.isArray(v)) {
		return "Array";
	}
	return typeof v;
}

function asTypeError(err: unknown): TypeError {
	if (err instanceof TypeError) {
		return err;
	}
	let message: string;
	if (err instanceof Error) {
		message = err.message;
	} else if (typeof err === "string") {
		message = err;
	} else {
		message = "compression stream error";
	}
	const te = new TypeError(message);
	if (err instanceof Error && err.stack) {
		te.stack = err.stack;
	}
	return te;
}

interface StreamState {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<BufferSource>;
}

const COMP_STATE = new WeakMap<CompressionStream, StreamState>();
const DECOMP_STATE = new WeakMap<DecompressionStream, StreamState>();

function buildCompressor(format: Format): FflateCompressor {
	if (format === "gzip") {
		return new Gzip();
	}
	if (format === "deflate") {
		return new Zlib();
	}
	return new Deflate();
}

function buildDecompressor(format: Format): FflateDecompressor {
	if (format === "gzip") {
		return new Gunzip();
	}
	if (format === "deflate") {
		return new Unzlib();
	}
	return new Inflate();
}

class CompressionStream {
	constructor(format: string) {
		if (!FORMATS.has(format)) {
			throw new TypeError(
				`Unsupported compression format: '${format}'. Must be one of: gzip, deflate, deflate-raw.`,
			);
		}
		const engine = buildCompressor(format as Format);
		let pending: TransformStreamDefaultController<Uint8Array> | null = null;
		engine.ondata = (data, _final) => {
			if (data.length > 0 && pending) {
				pending.enqueue(new Uint8Array(data));
			}
		};
		const ts = new TransformStream<BufferSource, Uint8Array>({
			transform: (chunk, controller) => {
				pending = controller;
				try {
					const bytes = toUint8Array(chunk);
					engine.push(bytes, false);
				} catch (err) {
					const te = asTypeError(err);
					controller.error(te);
					throw te;
				} finally {
					pending = null;
				}
			},
			flush: (controller) => {
				pending = controller;
				try {
					engine.push(new Uint8Array(0), true);
				} catch (err) {
					const te = asTypeError(err);
					controller.error(te);
					throw te;
				} finally {
					pending = null;
				}
			},
		});
		COMP_STATE.set(this, { readable: ts.readable, writable: ts.writable });
	}

	get readable(): ReadableStream<Uint8Array> {
		const s = COMP_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.readable;
	}
	get writable(): WritableStream<BufferSource> {
		const s = COMP_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.writable;
	}
}

class DecompressionStream {
	constructor(format: string) {
		if (!FORMATS.has(format)) {
			throw new TypeError(
				`Unsupported compression format: '${format}'. Must be one of: gzip, deflate, deflate-raw.`,
			);
		}
		const engine = buildDecompressor(format as Format);
		let pending: TransformStreamDefaultController<Uint8Array> | null = null;
		let sawFinal = false;
		let bytesSeen = 0;
		engine.ondata = (data, final) => {
			if (final) {
				sawFinal = true;
			}
			if (data.length > 0 && pending) {
				pending.enqueue(new Uint8Array(data));
			}
		};
		const ts = new TransformStream<BufferSource, Uint8Array>({
			transform: (chunk, controller) => {
				pending = controller;
				try {
					const bytes = toUint8Array(chunk);
					if (sawFinal && bytes.length > 0) {
						throw new TypeError(
							"Additional input received after end of compressed stream.",
						);
					}
					bytesSeen += bytes.length;
					engine.push(bytes, false);
				} catch (err) {
					const te = asTypeError(err);
					controller.error(te);
					throw te;
				} finally {
					pending = null;
				}
			},
			flush: (controller) => {
				pending = controller;
				try {
					engine.push(new Uint8Array(0), true);
					if (bytesSeen === 0) {
						throw new TypeError(
							"Unexpected end of compressed input (no data received).",
						);
					}
					if (!sawFinal) {
						throw new TypeError(
							"Unexpected end of compressed input (stream did not terminate).",
						);
					}
				} catch (err) {
					const te = asTypeError(err);
					controller.error(te);
					throw te;
				} finally {
					pending = null;
				}
			},
		});
		DECOMP_STATE.set(this, { readable: ts.readable, writable: ts.writable });
	}

	get readable(): ReadableStream<Uint8Array> {
		const s = DECOMP_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.readable;
	}
	get writable(): WritableStream<BufferSource> {
		const s = DECOMP_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.writable;
	}
}

for (const [name, value] of [
	["CompressionStream", CompressionStream],
	["DecompressionStream", DecompressionStream],
] as const) {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}
