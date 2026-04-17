import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import type { Bridge } from "./bridge-factory.js";
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

const SHA256_FIRST_16_RE = /^[0-9a-f]{32}$/;

function makeMemory(pages = 1): WebAssembly.Memory {
	return new WebAssembly.Memory({ initial: pages });
}

function makeBridge(active: boolean): {
	bridge: Bridge;
	calls: Array<{ method: string; input: unknown; output: unknown }>;
} {
	const calls: Array<{ method: string; input: unknown; output: unknown }> = [];
	const bridge = {
		getRunContext: () =>
			active
				? { invocationId: "evt", workflow: "wf", workflowSha: "sha" }
				: null,
		emitSystemCall: (method: string, input: unknown, output: unknown) => {
			calls.push({ method, input, output });
		},
	} as unknown as Bridge;
	return { bridge, calls };
}

// Pack a ciovec array and a payload into linear memory; returns the iovs
// struct base address and writes the bytes after it.
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
	it("writes the realtime value and emits a system.call event during a run", () => {
		const memory = makeMemory();
		const { bridge, calls } = makeBridge(true);
		const wState = createWasiState();
		wState.bridge = bridge;
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		const resultPtr = 32;
		const rc = overrides.clock_time_get(WASI_CLOCK_REALTIME, 0n, resultPtr);

		expect(rc).toBe(WASI_ERRNO_SUCCESS);
		const written = new DataView(memory.buffer).getBigUint64(resultPtr, true);
		expect(written).toBeGreaterThan(0n);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("wasi.clock_time_get");
		expect(calls[0]?.input).toEqual({ clockId: "REALTIME" });
		expect(typeof (calls[0]?.output as { ns: unknown })?.ns).toBe("number");
	});

	it("does not emit when no run context is active (pre-run reads are silent)", () => {
		const memory = makeMemory();
		const { bridge, calls } = makeBridge(false);
		const wState = createWasiState();
		wState.bridge = bridge;
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		const rc = overrides.clock_time_get(WASI_CLOCK_REALTIME, 0n, 32);

		expect(rc).toBe(WASI_ERRNO_SUCCESS);
		expect(calls).toHaveLength(0);
	});
});

describe("createWasiFactory — random_get", () => {
	it("fills the buffer and emits a system.call with size + sha256First16 only", () => {
		const memory = makeMemory();
		const { bridge, calls } = makeBridge(true);
		const wState = createWasiState();
		wState.bridge = bridge;
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		const bufPtr = 128;
		const bufLen = 32;
		const rc = overrides.random_get(bufPtr, bufLen);

		expect(rc).toBe(WASI_ERRNO_SUCCESS);
		const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
		// Cryptographic entropy should not leave a 32-byte buffer all-zero.
		expect(bytes.some((b) => b !== 0)).toBe(true);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("wasi.random_get");
		expect(calls[0]?.input).toEqual({ bufLen: 32 });
		const output = calls[0]?.output as {
			bufLen: number;
			sha256First16: string;
		};
		expect(output.bufLen).toBe(32);
		expect(output.sha256First16).toMatch(SHA256_FIRST_16_RE);
	});

	it("security invariant: emitted event never carries raw entropy bytes", () => {
		const memory = makeMemory();
		const { bridge, calls } = makeBridge(true);
		const wState = createWasiState();
		wState.bridge = bridge;
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		overrides.random_get(256, 16);

		expect(calls).toHaveLength(1);
		const serialized = JSON.stringify(calls[0]);
		const bytes = new Uint8Array(memory.buffer, 256, 16);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		// The full hex of the raw bytes should NOT appear anywhere in the event.
		expect(serialized).not.toContain(hex);
		// The keys permitted on output are exactly {bufLen, sha256First16}.
		const output = calls[0]?.output as Record<string, unknown>;
		expect(Object.keys(output).sort()).toEqual(["bufLen", "sha256First16"]);
	});

	it("does not emit when no run context is active", () => {
		const memory = makeMemory();
		const { bridge, calls } = makeBridge(false);
		const wState = createWasiState();
		wState.bridge = bridge;
		const post = vi.fn<(msg: WorkerToMain) => void>();
		const factory = createWasiFactory(wState, post);
		const overrides = factory(memory);

		overrides.random_get(256, 16);

		expect(calls).toHaveLength(0);
	});
});

describe("createWasiFactory — fd_write", () => {
	it("posts one log message per completed line and NO InvocationEvent", () => {
		const memory = makeMemory();
		const { bridge, calls } = makeBridge(true);
		const wState = createWasiState();
		wState.bridge = bridge;
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
		expect(msg?.type).toBe("log");
		if (msg?.type !== "log") {
			throw new Error("posted message was not a log message");
		}
		expect(msg.level).toBe("debug");
		expect(msg.message).toBe("quickjs.fd_write");
		expect(msg.meta).toEqual({ fd: WASI_STDERR_FD, text: "some diagnostic" });
		expect(calls).toHaveLength(0);
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

// Signature: the first argument type of emitSystemCall is what the tests
// above cross-check against, so this block exercises the Bridge contract
// independently of any emit call happening.
function _typeSignatureCheck(
	bridge: Bridge,
	event: InvocationEvent,
): InvocationEvent {
	bridge.emitSystemCall(
		"wasi.clock_time_get",
		{ clockId: "REALTIME" },
		{ ns: 0 },
	);
	return event;
}
