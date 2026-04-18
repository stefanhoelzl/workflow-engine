import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import { sandbox } from "./index.js";

const RUN_OPTS = {
	invocationId: "evt_test",
	tenant: "t0",
	workflow: "wf",
	workflowSha: "sha",
};

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

// The runtime appends this shim after every workflow bundle; mirroring it
// here lets us exercise the __hostCallAction bridge via the same call path
// that production code uses (SDK action callable → core.dispatchAction →
// globalThis.__dispatchAction → captured __hostCallAction) without pulling
// a runtime dependency into the sandbox package.
const DISPATCHER_SHIM = `(function() {
  var _hostCall = globalThis.__hostCallAction;
  var _emit = globalThis.__emitEvent;
  async function dispatch(name, input, handler, outputSchema) {
    _emit({ kind: "action.request", name, input });
    try {
      await _hostCall(name, input);
      const raw = await handler(input);
      const output = outputSchema.parse(raw);
      _emit({ kind: "action.response", name, output });
      return output;
    } catch (err) {
      const error = {
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack) : "",
      };
      if (err && err.issues !== undefined) error.issues = err.issues;
      _emit({ kind: "action.error", name, error });
      throw err;
    }
  }
  Object.defineProperty(globalThis, "__dispatchAction", {
    value: dispatch, writable: false, configurable: false, enumerable: false,
  });
  delete globalThis.__hostCallAction;
  delete globalThis.__emitEvent;
})();`;

function withDispatcher(bundleBody: string): string {
	return `${iife(bundleBody)}\n${DISPATCHER_SHIM}`;
}

describe("__hostCallAction RPC bridge (via dispatcher)", () => {
	it("invokes the registered host method and routes the action result to the guest", async () => {
		const impl = vi.fn().mockResolvedValue(undefined);
		const sb = await sandbox(
			withDispatcher(
				`exports.default = async (ctx) => {
					return await globalThis.__dispatchAction(
						"notify",
						{ ch: ctx.ch },
						async (input) => ({ ok: true, delivered: input.ch }),
						{ parse: (x) => x }
					);
				};`,
			),
			{ __hostCallAction: impl },
		);
		const res = await sb.run("default", { ch: "ops" }, RUN_OPTS);
		sb.dispose();

		expect(impl).toHaveBeenCalledWith("notify", { ch: "ops" });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.result).toEqual({ ok: true, delivered: "ops" });
		}
	});

	it("propagates a host-side validation rejection into the guest with issues preserved", async () => {
		const validationError = Object.assign(
			new Error("payload_validation_failed"),
			{ issues: [{ path: ["x"], message: "expected number" }] },
		);
		const impl = vi.fn().mockRejectedValue(validationError);
		const sb = await sandbox(
			withDispatcher(
				`exports.default = async () => {
					try {
						await globalThis.__dispatchAction(
							"notify",
							{ x: "bad" },
							async () => null,
							{ parse: (x) => x }
						);
						return "no-throw";
					} catch (e) {
						return { message: e.message, issues: e.issues };
					}
				};`,
			),
			{ __hostCallAction: impl },
		);
		const res = await sb.run("default", null, RUN_OPTS);
		sb.dispose();
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.result).toEqual({
				message: "payload_validation_failed",
				issues: [{ path: ["x"], message: "expected number" }],
			});
		}
	});

	it("host-side validation failure prevents handler invocation", async () => {
		const impl = vi.fn().mockRejectedValue(new Error("bad_input"));
		const handlerSpy = vi.fn();
		// We expose the spy via a construction-time method so we can observe
		// whether the handler was invoked from inside the sandbox.
		const sb = await sandbox(
			withDispatcher(
				`exports.default = async () => {
					try {
						await globalThis.__dispatchAction(
							"notify",
							{ x: "bad" },
							async () => { await globalThis.__handlerCalled(); return null; },
							{ parse: (x) => x }
						);
						return "no-throw";
					} catch (e) {
						return "threw";
					}
				};`,
			),
			{
				__hostCallAction: impl,
				__handlerCalled: async () => {
					handlerSpy();
				},
			},
		);
		const res = await sb.run("default", null, RUN_OPTS);
		sb.dispose();
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.result).toBe("threw");
		}
		expect(handlerSpy).not.toHaveBeenCalled();
	});

	it("emits system.request/system.response with the configured event name", async () => {
		const sb = await sandbox(
			withDispatcher(
				`exports.default = async () => {
					return await globalThis.__dispatchAction(
						"a",
						{ x: 1 },
						async () => 0,
						{ parse: (x) => x }
					);
				};`,
			),
			{ __hostCallAction: async () => undefined },
			{ methodEventNames: { __hostCallAction: "host.validateAction" } },
		);
		const events: InvocationEvent[] = [];
		sb.onEvent((e) => events.push(e));
		await sb.run("default", null, RUN_OPTS);
		sb.dispose();

		const req = events.find(
			(e) => e.kind === "system.request" && e.name === "host.validateAction",
		);
		const resp = events.find(
			(e) => e.kind === "system.response" && e.name === "host.validateAction",
		);
		expect(req).toBeDefined();
		expect(resp).toBeDefined();
		expect(resp?.ref).toBe(req?.seq);
	});
});
