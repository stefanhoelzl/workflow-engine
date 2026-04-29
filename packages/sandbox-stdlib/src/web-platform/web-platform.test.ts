import type { PluginContext } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import {
	guest,
	REPORT_ERROR_HOST,
	type ReportErrorPayload,
	name as WEB_PLATFORM_PLUGIN_NAME,
	worker,
} from "./index.js";

interface EmittedEvent {
	kind: string;
	name: string;
	extra: unknown;
}

function recordingCtx(): PluginContext & { events: EmittedEvent[] } {
	const events: EmittedEvent[] = [];
	return {
		events,
		emit(kind, options) {
			events.push({ kind, name: options.name, extra: options });
			return 0 as never;
		},
		request(_prefix, _options, fn) {
			return fn();
		},
	};
}

describe("web-platform plugin", () => {
	it("has the expected name and exposes the private reportError host descriptor", () => {
		expect(WEB_PLATFORM_PLUGIN_NAME).toBe("web-platform");
		const ctx = recordingCtx();
		const setup = worker(ctx);
		expect(setup.guestFunctions).toHaveLength(1);
		const gf = setup.guestFunctions?.[0];
		expect(gf?.name).toBe(REPORT_ERROR_HOST);
		expect(gf?.public).toBe(false);
	});

	it("exports a zero-arg guest function that the ?sandbox-plugin transform bundles into the Phase-2 IIFE", () => {
		expect(typeof guest).toBe("function");
	});

	it("reportErrorHost descriptor emits via auto-wrap as a system.exception leaf", () => {
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const gf = setup.guestFunctions?.[0];
		// The descriptor's `log` config drives the auto-wrap in
		// `bridge.installDescriptor`. Per the bridge-main-sequencing change,
		// uncaught errors emit as `system.exception` leaf events.
		expect(gf?.log).toEqual({ event: "system.exception" });
		// logName uses the reported error's class name for visual
		// disambiguation in the dashboard.
		const payload: ReportErrorPayload = {
			name: "TypeError",
			message: "boom",
			stack: "Error: boom\n  at eval",
		};
		expect(gf?.logName?.([payload])).toBe("TypeError");
		// logInput passes the full payload through as the event's input.
		expect(gf?.logInput?.([payload])).toEqual(payload);
	});
});
