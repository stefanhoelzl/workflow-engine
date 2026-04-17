import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Bridge } from "./bridge-factory.js";
import type { WorkerToMain } from "./protocol.js";

interface AnchorCell {
	ns: bigint;
}

interface WasiState {
	// Populated after createBridge; the wasi factory's closures read this to
	// emit system.call events and to gate emission on an active run context.
	bridge: Bridge | null;
	// Shared monotonic anchor cell — written by bridge.resetAnchor(), read by
	// wasiClockTimeGet for the MONOTONIC branch. Seeded at worker init (before
	// QuickJS.create) so the WASI clock returns small values during VM init,
	// which prevents QuickJS from caching a large reference for performance.now.
	anchor: AnchorCell;
	// Per-fd line buffers. fd_write hands us arbitrary byte slices; we only
	// post a log message once a complete line accumulates.
	fdLineBuffer: Map<number, string>;
}

function createWasiState(): WasiState {
	return {
		bridge: null,
		anchor: { ns: 0n },
		fdLineBuffer: new Map<number, string>(),
	};
}

const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;
const WASI_ERRNO_SUCCESS = 0;
const WASI_ERRNO_NOSYS = 52;
const WASI_ERRNO_BADF = 8;
const NS_PER_MS = 1_000_000n;
const NS_PER_MS_NUM = 1_000_000;
const WASI_STDOUT_FD = 1;
const WASI_STDERR_FD = 2;
// WASI ciovec (const iovec) is {bufPtr: u32, bufLen: u32} packed little-endian.
const WASI_CIOVEC_SIZE = 8;
const WASI_CIOVEC_LEN_OFFSET = 4;
// First 16 bytes of a SHA-256 digest rendered as lowercase hex.
const SHA256_FIRST_16_HEX_CHARS = 32;

function perfNowNs(): bigint {
	return BigInt(Math.trunc(performance.now() * NS_PER_MS_NUM));
}

function wasiClockTimeGet(
	memory: WebAssembly.Memory,
	wState: WasiState,
	clockId: number,
	resultPtr: number,
): number {
	const view = new DataView(memory.buffer);
	let timeNs: bigint;
	let clockLabel: "REALTIME" | "MONOTONIC";
	if (clockId === WASI_CLOCK_REALTIME) {
		timeNs = BigInt(Date.now()) * NS_PER_MS;
		clockLabel = "REALTIME";
	} else if (clockId === WASI_CLOCK_MONOTONIC) {
		timeNs = perfNowNs() - wState.anchor.ns;
		clockLabel = "MONOTONIC";
	} else {
		return WASI_ERRNO_NOSYS;
	}
	view.setBigUint64(resultPtr, timeNs, true);
	if (wState.bridge?.getRunContext()) {
		wState.bridge.emitSystemCall(
			"wasi.clock_time_get",
			{ clockId: clockLabel },
			{ ns: Number(timeNs) },
		);
	}
	return WASI_ERRNO_SUCCESS;
}

function wasiRandomGet(
	memory: WebAssembly.Memory,
	wState: WasiState,
	bufPtr: number,
	bufLen: number,
): number {
	const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
	globalThis.crypto.getRandomValues(bytes);
	if (wState.bridge?.getRunContext()) {
		// First 16 bytes of SHA-256 only — raw entropy bytes are never logged.
		const sha256First16 = createHash("sha256")
			.update(bytes)
			.digest("hex")
			.slice(0, SHA256_FIRST_16_HEX_CHARS);
		wState.bridge.emitSystemCall(
			"wasi.random_get",
			{ bufLen },
			{ bufLen, sha256First16 },
		);
	}
	return WASI_ERRNO_SUCCESS;
}

interface FdWriteArgs {
	fd: number;
	iovsPtr: number;
	iovsLen: number;
	nwrittenPtr: number;
}

function wasiFdWrite(
	memory: WebAssembly.Memory,
	wState: WasiState,
	postFn: (msg: WorkerToMain) => void,
	args: FdWriteArgs,
): number {
	const { fd, iovsPtr, iovsLen, nwrittenPtr } = args;
	if (fd !== WASI_STDOUT_FD && fd !== WASI_STDERR_FD) {
		return WASI_ERRNO_BADF;
	}
	const view = new DataView(memory.buffer);
	const bytes = new Uint8Array(memory.buffer);
	const decoder = new TextDecoder();
	let totalWritten = 0;
	let decoded = "";
	for (let i = 0; i < iovsLen; i++) {
		const chunkPtr = view.getUint32(iovsPtr + i * WASI_CIOVEC_SIZE, true);
		const chunkLen = view.getUint32(
			iovsPtr + i * WASI_CIOVEC_SIZE + WASI_CIOVEC_LEN_OFFSET,
			true,
		);
		decoded += decoder.decode(bytes.slice(chunkPtr, chunkPtr + chunkLen));
		totalWritten += chunkLen;
	}
	view.setUint32(nwrittenPtr, totalWritten, true);
	const prev = wState.fdLineBuffer.get(fd) ?? "";
	const combined = prev + decoded;
	const lines = combined.split("\n");
	const trailing = lines.pop() ?? "";
	for (const line of lines) {
		postFn({
			type: "log",
			level: "debug",
			message: "quickjs.fd_write",
			meta: { fd, text: line },
		});
	}
	wState.fdLineBuffer.set(fd, trailing);
	return WASI_ERRNO_SUCCESS;
}

function createWasiFactory(
	wState: WasiState,
	postFn: (msg: WorkerToMain) => void,
) {
	return (memory: WebAssembly.Memory) => ({
		// biome-ignore lint/style/useNamingConvention: WASI spec name
		clock_time_get: (clockId: number, _precision: bigint, resultPtr: number) =>
			wasiClockTimeGet(memory, wState, clockId, resultPtr),
		// biome-ignore lint/style/useNamingConvention: WASI spec name
		random_get: (bufPtr: number, bufLen: number) =>
			wasiRandomGet(memory, wState, bufPtr, bufLen),
		// biome-ignore lint/style/useNamingConvention: WASI spec name
		fd_write: (
			fd: number,
			iovsPtr: number,
			iovsLen: number,
			nwrittenPtr: number,
		) =>
			wasiFdWrite(memory, wState, postFn, {
				fd,
				iovsPtr,
				iovsLen,
				nwrittenPtr,
			}),
	});
}

export type { AnchorCell, WasiState };
export {
	createWasiFactory,
	createWasiState,
	perfNowNs,
	WASI_CIOVEC_LEN_OFFSET,
	WASI_CIOVEC_SIZE,
	WASI_CLOCK_MONOTONIC,
	WASI_CLOCK_REALTIME,
	WASI_ERRNO_BADF,
	WASI_ERRNO_SUCCESS,
	WASI_STDERR_FD,
	WASI_STDOUT_FD,
	wasiClockTimeGet,
	wasiFdWrite,
	wasiRandomGet,
};
