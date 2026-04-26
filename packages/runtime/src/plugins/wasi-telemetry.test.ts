import { recordingContext } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import {
	dependsOn as WASI_TELEMETRY_DEPS,
	name as WASI_TELEMETRY_NAME,
	worker,
} from "./wasi-telemetry.js";

describe("wasi-telemetry plugin", () => {
	it("declares the expected plugin identity and depends on the base wasi plugin", () => {
		expect(WASI_TELEMETRY_NAME).toBe("wasi-telemetry");
		expect(WASI_TELEMETRY_DEPS).toEqual(["wasi"]);
	});

	it("worker() returns wasiHooks covering clock/random/fd_write", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		expect(setup.wasiHooks).toBeDefined();
		expect(typeof setup.wasiHooks?.clockTimeGet).toBe("function");
		expect(typeof setup.wasiHooks?.randomGet).toBe("function");
		expect(typeof setup.wasiHooks?.fdWrite).toBe("function");
	});

	it("clockTimeGet emits a system.call leaf with name=wasi.clock_time_get", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const result = setup.wasiHooks?.clockTimeGet?.({
			label: "MONOTONIC",
			defaultNs: 12_345,
		});
		expect(result).toBeUndefined();
		expect(ctx.events).toHaveLength(1);
		expect(ctx.events[0]?.kind).toBe("system.call");
		expect(ctx.events[0]?.options.name).toBe("wasi.clock_time_get");
		expect(ctx.events[0]?.options.input).toEqual({ label: "MONOTONIC" });
		expect(ctx.events[0]?.options.output).toEqual({ ns: 12_345 });
	});

	it("randomGet emits sha256-prefix digest, NOT raw bytes (SECURITY.md §2 R-8)", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const result = setup.wasiHooks?.randomGet?.({
			bufLen: 8,
			defaultBytes: bytes,
		});
		expect(result).toBeUndefined();
		expect(ctx.events).toHaveLength(1);
		const evt = ctx.events[0];
		expect(evt?.kind).toBe("system.call");
		expect(evt?.options.name).toBe("wasi.random_get");
		const out = evt?.options.output as {
			bufLen: number;
			sha256First16: string;
		};
		expect(out.bufLen).toBe(8);
		expect(out.sha256First16).toMatch(/^[0-9a-f]{16}$/);
		const json = JSON.stringify(evt?.options);
		expect(json).not.toContain("bytes");
		expect(json).not.toMatch(/\[\s*1\s*,\s*2\s*,\s*3/);
	});

	it("fdWrite emits a system.call leaf with name=wasi.fd_write and {fd, text}", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.wasiHooks?.fdWrite?.({ fd: 2, text: "diagnostic line" });
		expect(ctx.events).toHaveLength(1);
		expect(ctx.events[0]?.kind).toBe("system.call");
		expect(ctx.events[0]?.options.name).toBe("wasi.fd_write");
		expect(ctx.events[0]?.options.input).toEqual({
			fd: 2,
			text: "diagnostic line",
		});
	});
});
