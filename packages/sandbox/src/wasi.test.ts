import { describe, expect, it, vi } from "vitest";
import type { WorkerToMain } from "./protocol.js";
import {
	createWasiFactory,
	createWasiState,
	WASI_CIOVEC_LEN_OFFSET,
	WASI_CIOVEC_SIZE,
	WASI_CLOCK_REALTIME,
	WASI_ERRNO_BADF,
	WASI_ERRNO_SUCCESS,
	WASI_STDERR_FD,
	WASI_STDOUT_FD,
} from "./wasi.js";

// --- Test harness --------------------------------------------------------
//
// Plugin-era WASI: the factory no longer emits `system.call` events. A
// wasi-plugin (sandbox-stdlib / runtime telemetry variants) registers
// hooks via `wasiHooks` and emits its own `ctx.emit` events. These tests
// exercise the pure-WASI contract (buffer writes, error codes, fd_write
// line-buffering to `post({type:"log"})`). Plugin-level event emission is
// covered in `wasi-hooks.test.ts` and the sandbox-stdlib plugin tests.

function makeMemory(pages = 1): WebAssembly.Memory {
	return new WebAssembly.Memory({ initial: pages });
}

function packIovs(
	memory: WebAssembly.Memory,
	chunks: string[],
): {
	iovsPtr: number;
	iovsLen: number;
	nwrittenPtr: number;
} {
	const view = new DataView(memory.buffer);
	const bytes = new Uint8Array(memory.buffer);
	const iovsPtr = 64;
	const nwrittenPtr = iovsPtr + chunks.length * WASI_CIOVEC_SIZE;
	let payloadPtr = nwrittenPtr + 4;
	const encoder = new TextEncoder();
	for (let i = 0; i < chunks.length; i++) {
		const encoded = encoder.encode(chunks[i]);
		bytes.set(encoded, payloadPtr);
		view.setUint32(iovsPtr + i * WASI_CIOVEC_SIZE, payloadPtr, true);
		view.setUint32(
			iovsPtr + i * WASI_CIOVEC_SIZE + WASI_CIOVEC_LEN_OFFSET,
			encoded.byteLength,
			true,
		);
		payloadPtr += encoded.byteLength;
	}
	return { iovsPtr, iovsLen: chunks.length, nwrittenPtr };
}

describe("createWasiFactory — clock_time_get", () => {
	it("writes the realtime value to resultPtr", () => {
		const memory = makeMemory();
		const wState = createWasiState();
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		const resultPtr = 32;
		const rc = overrides.clock_time_get(WASI_CLOCK_REALTIME, 0n, resultPtr);

		expect(rc).toBe(WASI_ERRNO_SUCCESS);
		const written = new DataView(memory.buffer).getBigUint64(resultPtr, true);
		expect(written).toBeGreaterThan(0n);
	});
});

describe("createWasiFactory — random_get", () => {
	it("fills the buffer with cryptographic entropy", () => {
		const memory = makeMemory();
		const wState = createWasiState();
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		const bufPtr = 128;
		const bufLen = 32;
		const rc = overrides.random_get(bufPtr, bufLen);

		expect(rc).toBe(WASI_ERRNO_SUCCESS);
		const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
		expect(bytes.some((b) => b !== 0)).toBe(true);
	});
});

describe("createWasiFactory — fd_write", () => {
	it("posts one log message per completed line on stderr", () => {
		const memory = makeMemory();
		const wState = createWasiState();
		const posted: WorkerToMain[] = [];
		const factory = createWasiFactory(wState, (msg) => posted.push(msg));
		const overrides = factory(memory);

		const { iovsPtr, iovsLen, nwrittenPtr } = packIovs(memory, [
			"some diagnostic\n",
		]);
		const rc = overrides.fd_write(
			WASI_STDERR_FD,
			iovsPtr,
			iovsLen,
			nwrittenPtr,
		);

		expect(rc).toBe(WASI_ERRNO_SUCCESS);
		expect(posted).toHaveLength(1);
		const msg = posted[0];
		if (msg?.type !== "log") {
			throw new Error("posted message was not a log message");
		}
		expect(msg.level).toBe("debug");
		expect(msg.message).toBe("quickjs.fd_write");
		expect(msg.meta).toEqual({ fd: WASI_STDERR_FD, text: "some diagnostic" });
	});

	it("buffers partial lines and emits only on newline", () => {
		const memory = makeMemory();
		const wState = createWasiState();
		const posted: WorkerToMain[] = [];
		const factory = createWasiFactory(wState, (msg) => posted.push(msg));
		const overrides = factory(memory);

		const first = packIovs(memory, ["partial"]);
		overrides.fd_write(
			WASI_STDOUT_FD,
			first.iovsPtr,
			first.iovsLen,
			first.nwrittenPtr,
		);
		expect(posted).toHaveLength(0);

		const second = packIovs(memory, [" line\n"]);
		overrides.fd_write(
			WASI_STDOUT_FD,
			second.iovsPtr,
			second.iovsLen,
			second.nwrittenPtr,
		);
		expect(posted).toHaveLength(1);
		const msg = posted[0];
		if (msg?.type !== "log") {
			throw new Error("posted message was not a log message");
		}
		expect(msg.meta).toEqual({ fd: WASI_STDOUT_FD, text: "partial line" });
	});

	it("returns BADF for fds other than stdout/stderr", () => {
		const memory = makeMemory();
		const wState = createWasiState();
		const posted: WorkerToMain[] = [];
		const factory = createWasiFactory(wState, (msg) => posted.push(msg));
		const overrides = factory(memory);

		const { iovsPtr, iovsLen, nwrittenPtr } = packIovs(memory, ["ignored\n"]);
		const rc = overrides.fd_write(42, iovsPtr, iovsLen, nwrittenPtr);

		expect(rc).toBe(WASI_ERRNO_BADF);
		expect(posted).toHaveLength(0);
	});
});
