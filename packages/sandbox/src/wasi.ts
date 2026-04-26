import { performance } from "node:perf_hooks";
import type {
	WasiClockArgs,
	WasiClockResult,
	WasiFdWriteArgs,
	WasiRandomArgs,
	WasiRandomResult,
} from "./plugin.js";
import type { WorkerToMain } from "./protocol.js";

interface AnchorCell {
	ns: bigint;
}

/**
 * Mutable callback slots for WASI host-side overrides. Start unset; a
 * plugin populates them by returning `wasiHooks` from `worker()`, which
 * `installWasiHooks` routes into these slots (one plugin per slot,
 * collision rejected at install time). At WASI dispatch each slot is
 * consulted: if set, the hook observes the computed default and may
 * return an override (`{ ns }` / `{ bytes }`); if unset, the default
 * value is used unchanged and no event is emitted.
 */
interface WasiSlots {
	clockTimeGet: ((args: WasiClockArgs) => WasiClockResult | undefined) | null;
	randomGet: ((args: WasiRandomArgs) => WasiRandomResult | undefined) | null;
	fdWrite: ((args: WasiFdWriteArgs) => void) | null;
}

interface WasiState {
	// Shared monotonic anchor cell — written by bridge.resetAnchor(), read by
	// wasiClockTimeGet for the MONOTONIC branch. Seeded at worker init (before
	// QuickJS.create) so the WASI clock returns small values during VM init,
	// which prevents QuickJS from caching a large reference for performance.now.
	anchor: AnchorCell;
	// Per-fd line buffers. fd_write hands us arbitrary byte slices; we only
	// post a log message once a complete line accumulates.
	fdLineBuffer: Map<number, string>;
	// Plugin-supplied override callbacks — see WasiSlots for semantics.
	slots: WasiSlots;
}

function createWasiState(): WasiState {
	return {
		anchor: { ns: 0n },
		fdLineBuffer: new Map<number, string>(),
		slots: { clockTimeGet: null, randomGet: null, fdWrite: null },
	};
}

class WasiHookCollisionError extends Error {
	readonly name = "WasiHookCollisionError";
	readonly hook: "clockTimeGet" | "randomGet" | "fdWrite";
	constructor(hook: "clockTimeGet" | "randomGet" | "fdWrite") {
		super(
			`multiple plugins registered a wasi hook for "${hook}" — only one is allowed`,
		);
		this.hook = hook;
	}
}

/**
 * Install a plugin's WasiHooks into the shared WasiSlots. Throws
 * WasiHookCollisionError if a slot is already populated — only one plugin
 * may own any given WASI hook.
 */
function installWasiHooks(
	state: WasiState,
	hooks: {
		readonly clockTimeGet?: (
			args: WasiClockArgs,
		) => WasiClockResult | undefined;
		readonly randomGet?: (args: WasiRandomArgs) => WasiRandomResult | undefined;
		readonly fdWrite?: (args: WasiFdWriteArgs) => void;
	},
): void {
	if (hooks.clockTimeGet) {
		if (state.slots.clockTimeGet !== null) {
			throw new WasiHookCollisionError("clockTimeGet");
		}
		state.slots.clockTimeGet = hooks.clockTimeGet;
	}
	if (hooks.randomGet) {
		if (state.slots.randomGet !== null) {
			throw new WasiHookCollisionError("randomGet");
		}
		state.slots.randomGet = hooks.randomGet;
	}
	if (hooks.fdWrite) {
		if (state.slots.fdWrite !== null) {
			throw new WasiHookCollisionError("fdWrite");
		}
		state.slots.fdWrite = hooks.fdWrite;
	}
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
	let defaultNs: bigint;
	let clockLabel: "REALTIME" | "MONOTONIC";
	if (clockId === WASI_CLOCK_REALTIME) {
		defaultNs = BigInt(Date.now()) * NS_PER_MS;
		clockLabel = "REALTIME";
	} else if (clockId === WASI_CLOCK_MONOTONIC) {
		defaultNs = perfNowNs() - wState.anchor.ns;
		clockLabel = "MONOTONIC";
	} else {
		return WASI_ERRNO_NOSYS;
	}
	// Plugin-supplied hook (if any) observes the default and may override
	// it; return undefined to keep the default.
	let timeNs = defaultNs;
	if (wState.slots.clockTimeGet) {
		const result = wState.slots.clockTimeGet({
			label: clockLabel,
			defaultNs: Number(defaultNs),
		});
		if (result?.ns !== undefined) {
			timeNs = BigInt(result.ns);
		}
	}
	view.setBigUint64(resultPtr, timeNs, true);
	return WASI_ERRNO_SUCCESS;
}

function wasiRandomGet(
	memory: WebAssembly.Memory,
	wState: WasiState,
	bufPtr: number,
	bufLen: number,
): number {
	const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
	// Compute the default (real entropy) first so the plugin hook can
	// observe it or replace it. Using a temp buffer avoids touching WASM
	// memory twice in the common (no-hook) case.
	const defaultBytes = new Uint8Array(bufLen);
	globalThis.crypto.getRandomValues(defaultBytes);
	// Type as the widened Uint8Array so a plugin's Uint8Array<ArrayBufferLike>
	// can be assigned without a TS narrowing error.
	let finalBytes: Uint8Array = defaultBytes;
	if (wState.slots.randomGet) {
		const result = wState.slots.randomGet({ bufLen, defaultBytes });
		if (result?.bytes !== undefined) {
			finalBytes = result.bytes;
		}
	}
	bytes.set(finalBytes.subarray(0, bufLen));
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
	// Plugin hook sees each raw write individually; default line-buffering
	// only applies when no hook is installed.
	if (wState.slots.fdWrite) {
		wState.slots.fdWrite({ fd, text: decoded });
	} else {
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
	}
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

export type { AnchorCell, WasiSlots, WasiState };
export {
	createWasiFactory,
	createWasiState,
	installWasiHooks,
	perfNowNs,
	WASI_CIOVEC_LEN_OFFSET,
	WASI_CIOVEC_SIZE,
	WASI_CLOCK_MONOTONIC,
	WASI_CLOCK_REALTIME,
	WASI_ERRNO_BADF,
	WASI_ERRNO_SUCCESS,
	WASI_STDERR_FD,
	WASI_STDOUT_FD,
	WasiHookCollisionError,
	wasiClockTimeGet,
	wasiFdWrite,
	wasiRandomGet,
};
