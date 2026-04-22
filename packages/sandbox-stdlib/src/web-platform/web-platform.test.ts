import type { SandboxContext } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import {
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

function recordingCtx(): SandboxContext & { events: EmittedEvent[] } {
	const events: EmittedEvent[] = [];
	return {
		events,
		emit(kind, name, extra) {
			events.push({ kind, name, extra });
		},
		request(_prefix, _name, _extra, fn) {
			return fn();
		},
	};
}

describe("web-platform plugin (§10 shape)", () => {
	it("has the expected name and exposes the private reportError host descriptor", () => {
		expect(WEB_PLATFORM_PLUGIN_NAME).toBe("web-platform");
		const ctx = recordingCtx();
		const setup = worker(ctx, {}, {});
		expect(setup.guestFunctions).toHaveLength(1);
		const gf = setup.guestFunctions?.[0];
		expect(gf?.name).toBe(REPORT_ERROR_HOST);
		expect(gf?.public).toBe(false);
	});

	it("omits source when no bundle is supplied", () => {
		const ctx = recordingCtx();
		const setup = worker(ctx, {}, {});
		expect(setup.source).toBeUndefined();
	});

	it("forwards supplied bundleSource as the plugin's Phase-2 source", () => {
		const bundle = "(() => { globalThis.installed = true; })();";
		const ctx = recordingCtx();
		const setup = worker(ctx, {}, { bundleSource: bundle });
		expect(setup.source).toBe(bundle);
	});

	it("reportErrorHost handler emits an uncaught-error leaf event with the serialised payload", () => {
		const ctx = recordingCtx();
		const setup = worker(ctx, {}, {});
		const gf = setup.guestFunctions?.[0];
		const handler = gf?.handler as unknown as (
			payload: ReportErrorPayload,
		) => void;
		handler({
			name: "TypeError",
			message: "boom",
			stack: "Error: boom\n  at eval",
		});
		expect(ctx.events).toEqual([
			{
				kind: "uncaught-error",
				name: "reportError",
				extra: {
					input: {
						name: "TypeError",
						message: "boom",
						stack: "Error: boom\n  at eval",
					},
				},
			},
		]);
	});
});
