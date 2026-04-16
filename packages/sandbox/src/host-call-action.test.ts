import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import { sandbox } from "./index.js";

const RUN_OPTS = {
	invocationId: "evt_test",
	workflow: "wf",
	workflowSha: "sha",
};

describe("__hostCallAction RPC bridge", () => {
	it("invokes the registered host method and returns its result to the guest", async () => {
		const impl = vi.fn().mockResolvedValue({ ok: true });
		const sb = await sandbox(
			`export default async (ctx) => {
        const r = await __hostCallAction("notify", { ch: ctx.ch });
        return r;
      }`,
			{ __hostCallAction: impl },
		);
		const res = await sb.run("default", { ch: "ops" }, RUN_OPTS);
		sb.dispose();

		expect(impl).toHaveBeenCalledWith("notify", { ch: "ops" });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.result).toEqual({ ok: true });
		}
	});

	it("propagates a host method rejection into the guest as a rejected promise", async () => {
		const impl = vi
			.fn()
			.mockRejectedValue(new Error("payload_validation_failed"));
		const sb = await sandbox(
			`export default async () => {
        try {
          await __hostCallAction("notify", { x: "bad" });
          return "no-throw";
        } catch (e) {
          return e.message;
        }
      }`,
			{ __hostCallAction: impl },
		);
		const res = await sb.run("default", null, RUN_OPTS);
		sb.dispose();
		if (res.ok) {
			expect(res.result).toBe("payload_validation_failed");
		} else {
			throw new Error("expected ok");
		}
	});

	it("emits system.request/system.response with the configured event name", async () => {
		const sb = await sandbox(
			`export default async () => { await __hostCallAction("a", { x: 1 }); return 0 }`,
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
