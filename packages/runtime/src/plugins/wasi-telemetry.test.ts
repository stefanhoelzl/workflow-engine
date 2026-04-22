import type {
	EmitOptions,
	EventExtra,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import {
	dependsOn as WASI_TELEMETRY_DEPS,
	name as WASI_TELEMETRY_NAME,
	worker,
} from "./wasi-telemetry.js";

interface EmittedEvent {
	kind: string;
	name: string;
	extra: EventExtra;
	options?: EmitOptions;
}

function recordingContext(): SandboxContext & {
	readonly events: EmittedEvent[];
} {
	const events: EmittedEvent[] = [];
	return {
		events,
		emit(kind, name, extra, options) {
			events.push({
				kind,
				name,
				extra,
				...(options === undefined ? {} : { options }),
			});
		},
		request(_prefix, _name, _extra, fn) {
			return fn();
		},
	};
}

describe("wasi-telemetry plugin (§10 shape, design §6)", () => {
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

	it("clockTimeGet hook emits a wasi.clock_time_get leaf event and returns undefined (observe-only)", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const result = setup.wasiHooks?.clockTimeGet?.({
			label: "MONOTONIC",
			defaultNs: 12_345,
		});
		expect(result).toBeUndefined();
		expect(ctx.events).toEqual([
			{
				kind: "wasi.clock_time_get",
				name: "",
				extra: {
					input: { label: "MONOTONIC" },
					output: { ns: 12_345 },
				},
			},
		]);
	});

	it("randomGet hook emits sha256-prefix digest, NOT raw bytes (SECURITY.md §2 R-8)", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const result = setup.wasiHooks?.randomGet?.({
			bufLen: 8,
			defaultBytes: bytes,
		});
		expect(result).toBeUndefined();
		expect(ctx.events).toHaveLength(1);
		const [evt] = ctx.events;
		expect(evt?.kind).toBe("wasi.random_get");
		const out = evt?.extra.output as {
			bufLen: number;
			sha256First16: string;
		};
		// Only the byte count + hex-prefixed sha256 leave the plugin boundary.
		// Raw bytes MUST NOT appear anywhere in the emitted event.
		expect(out.bufLen).toBe(8);
		expect(out.sha256First16).toMatch(/^[0-9a-f]{16}$/);
		const extraJson = JSON.stringify(evt?.extra);
		expect(extraJson).not.toContain("bytes");
		// No embedded raw-byte array in either input or output.
		expect(extraJson).not.toMatch(/\[\s*1\s*,\s*2\s*,\s*3/);
	});

	it("fdWrite hook emits a wasi.fd_write leaf event with {fd, text}", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.wasiHooks?.fdWrite?.({ fd: 2, text: "diagnostic line" });
		expect(ctx.events).toEqual([
			{
				kind: "wasi.fd_write",
				name: "",
				extra: { input: { fd: 2, text: "diagnostic line" } },
			},
		]);
	});
});
