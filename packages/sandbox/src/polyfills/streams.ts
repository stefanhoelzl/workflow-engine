// Streams polyfill — ReadableStream / WritableStream / TransformStream /
// ByteLengthQueuingStrategy / CountQueuingStrategy from web-streams-polyfill
// (ponyfill; no global side-effects), plus hand-rolled TextEncoderStream /
// TextDecoderStream wrappers that HAVE-A TransformStream (the ponyfill
// ships these streams but NOT their Encoding-spec siblings).

import {
	ByteLengthQueuingStrategy,
	CountQueuingStrategy,
	ReadableByteStreamController,
	ReadableStream,
	ReadableStreamBYOBReader,
	ReadableStreamBYOBRequest,
	ReadableStreamDefaultController,
	ReadableStreamDefaultReader,
	TransformStream,
	TransformStreamDefaultController,
	WritableStream,
	WritableStreamDefaultController,
	WritableStreamDefaultWriter,
} from "web-streams-polyfill";

interface DecoderState {
	readable: ReadableStream<string>;
	writable: WritableStream<BufferSource>;
	decoder: TextDecoder;
}
const DEC_STATE = new WeakMap<TextDecoderStream, DecoderState>();

class TextDecoderStream {
	constructor(
		label = "utf-8",
		options: { fatal?: boolean; ignoreBOM?: boolean } = {},
	) {
		const decoder = new TextDecoder(label, options);
		const ts = new TransformStream<BufferSource, string>({
			transform(chunk, controller) {
				if (!(ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer)) {
					throw new TypeError(
						"Can only write BufferSource chunks to a TextDecoderStream",
					);
				}
				const s = decoder.decode(chunk as ArrayBufferView, { stream: true });
				if (s.length > 0) {
					controller.enqueue(s);
				}
			},
			flush(controller) {
				const s = decoder.decode();
				if (s.length > 0) {
					controller.enqueue(s);
				}
			},
		});
		DEC_STATE.set(this, {
			readable: ts.readable,
			writable: ts.writable,
			decoder,
		});
	}

	get encoding(): string {
		const s = DEC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.decoder.encoding;
	}
	get fatal(): boolean {
		const s = DEC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.decoder.fatal;
	}
	get ignoreBOM(): boolean {
		const s = DEC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.decoder.ignoreBOM;
	}
	get readable(): ReadableStream<string> {
		const s = DEC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.readable;
	}
	get writable(): WritableStream<BufferSource> {
		const s = DEC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.writable;
	}
}

interface EncoderState {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<string>;
}
const ENC_STATE = new WeakMap<TextEncoderStream, EncoderState>();

// Holds a lone high surrogate across chunks. Spec §Encoding §TextEncoderStream
// requires pairing with the next chunk's leading low surrogate, or emitting
// U+FFFD on flush if unpaired.
class TextEncoderStream {
	constructor() {
		const encoder = new TextEncoder();
		let pendingHigh: string | null = null;
		const ts = new TransformStream<string, Uint8Array>({
			transform(chunk, controller) {
				let str = String(chunk);
				if (pendingHigh !== null) {
					str = pendingHigh + str;
					pendingHigh = null;
				}
				if (str.length > 0) {
					const last = str.charCodeAt(str.length - 1);
					if (last >= 0xd8_00 && last <= 0xdb_ff) {
						pendingHigh = str.slice(-1);
						str = str.slice(0, -1);
					}
				}
				if (str.length > 0) {
					controller.enqueue(encoder.encode(str));
				}
			},
			flush(controller) {
				if (pendingHigh !== null) {
					controller.enqueue(encoder.encode(pendingHigh));
					pendingHigh = null;
				}
			},
		});
		ENC_STATE.set(this, { readable: ts.readable, writable: ts.writable });
	}

	get encoding(): string {
		if (!ENC_STATE.has(this)) {
			throw new TypeError("Illegal invocation");
		}
		return "utf-8";
	}
	get readable(): ReadableStream<Uint8Array> {
		const s = ENC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.readable;
	}
	get writable(): WritableStream<string> {
		const s = ENC_STATE.get(this);
		if (!s) {
			throw new TypeError("Illegal invocation");
		}
		return s.writable;
	}
}

for (const [name, value] of [
	["ReadableStream", ReadableStream],
	["ReadableStreamDefaultController", ReadableStreamDefaultController],
	["ReadableStreamDefaultReader", ReadableStreamDefaultReader],
	["ReadableByteStreamController", ReadableByteStreamController],
	["ReadableStreamBYOBReader", ReadableStreamBYOBReader],
	["ReadableStreamBYOBRequest", ReadableStreamBYOBRequest],
	["WritableStream", WritableStream],
	["WritableStreamDefaultController", WritableStreamDefaultController],
	["WritableStreamDefaultWriter", WritableStreamDefaultWriter],
	["TransformStream", TransformStream],
	["TransformStreamDefaultController", TransformStreamDefaultController],
	["ByteLengthQueuingStrategy", ByteLengthQueuingStrategy],
	["CountQueuingStrategy", CountQueuingStrategy],
	["TextEncoderStream", TextEncoderStream],
	["TextDecoderStream", TextDecoderStream],
] as const) {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}
