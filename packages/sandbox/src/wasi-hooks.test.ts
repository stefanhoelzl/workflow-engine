import { describe, expect, it } from "vitest";
import {
	name as WASI_PLUGIN_NAME,
	worker as wasiWorker,
} from "./plugins/wasi-plugin.js";
import {
	createWasiState,
	installWasiHooks,
	WasiHookCollisionError,
} from "./wasi.js";

describe("wasi plugin (§10 shape — inert base)", () => {
	it("has the expected name and its worker() returns undefined (no hooks)", () => {
		expect(WASI_PLUGIN_NAME).toBe("wasi");
		const setup = wasiWorker();
		expect(setup).toBeUndefined();
	});
});

describe("installWasiHooks", () => {
	it("populates empty slots from the provided WasiHooks", () => {
		const state = createWasiState();
		const clockFn = () => ({ ns: 1 });
		const randomFn = () => ({ bytes: new Uint8Array([0]) });
		const fdFn = () => undefined;
		installWasiHooks(state, {
			clockTimeGet: clockFn,
			randomGet: randomFn,
			fdWrite: fdFn,
		});
		expect(state.slots.clockTimeGet).toBe(clockFn);
		expect(state.slots.randomGet).toBe(randomFn);
		expect(state.slots.fdWrite).toBe(fdFn);
	});

	it("leaves unspecified slots alone", () => {
		const state = createWasiState();
		expect(state.slots.randomGet).toBeNull();
		installWasiHooks(state, { clockTimeGet: () => undefined });
		expect(state.slots.clockTimeGet).not.toBeNull();
		expect(state.slots.randomGet).toBeNull();
		expect(state.slots.fdWrite).toBeNull();
	});

	it("throws WasiHookCollisionError when two plugins both claim the same hook slot", () => {
		const state = createWasiState();
		installWasiHooks(state, { clockTimeGet: () => undefined });
		expect(() =>
			installWasiHooks(state, { clockTimeGet: () => undefined }),
		).toThrow(WasiHookCollisionError);
		expect(() =>
			installWasiHooks(state, { clockTimeGet: () => undefined }),
		).toThrow(
			/multiple plugins registered a wasi hook for "clockTimeGet" — only one is allowed/,
		);
	});

	it("allows distinct plugins to claim disjoint slots", () => {
		const state = createWasiState();
		installWasiHooks(state, { clockTimeGet: () => undefined });
		expect(() =>
			installWasiHooks(state, { randomGet: () => undefined }),
		).not.toThrow();
		expect(state.slots.clockTimeGet).not.toBeNull();
		expect(state.slots.randomGet).not.toBeNull();
	});
});
