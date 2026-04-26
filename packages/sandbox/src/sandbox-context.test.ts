import { describe, expect, it } from "vitest";
import type { Bridge, EmitFraming } from "./bridge-factory.js";
import type { WireEvent } from "./protocol.js";
import { createSandboxContext } from "./sandbox-context.js";

/**
 * Minimal Bridge stand-in. Exposes the post-refactor Bridge surface:
 * `buildEvent(kind, name, framing, extra) → CallId`, `setSink`, `emit`,
 * `setRunActive`/`clearRunActive`/`resetCallIds`, plus VM/marshal/arg/anchor
 * methods touched by createSandboxContext only via type compatibility. The
 * fake is pre-activated so tests don't need to call setRunActive themselves.
 */
interface FakeBridge extends Bridge {
	readonly events: WireEvent[];
}

function createFakeBridge(): FakeBridge {
	const events: WireEvent[] = [];
	let nextCallId = 0;
	let active = true;
	const bridge = {
		events,
		buildEvent: (
			kind: string,
			name: string,
			framing: EmitFraming,
			extra: { input?: unknown; output?: unknown; error?: unknown },
		): number => {
			if (!active) {
				return 0;
			}
			let wireType: WireEvent["type"];
			let assignedId = 0;
			if (framing === "leaf") {
				wireType = "leaf";
			} else if (framing === "open") {
				assignedId = nextCallId++;
				wireType = { open: assignedId };
			} else {
				wireType = { close: framing.close };
			}
			const event = {
				kind,
				name,
				ts: 0,
				at: "1970-01-01T00:00:00.000Z",
				type: wireType,
				...(extra.input === undefined ? {} : { input: extra.input }),
				...(extra.output === undefined ? {} : { output: extra.output }),
				...(extra.error === undefined
					? {}
					: {
							error: extra.error as NonNullable<WireEvent["error"]>,
						}),
			} satisfies WireEvent;
			events.push(event);
			return assignedId;
		},
		emit: (_e: WireEvent) => {
			/* unused in these tests — buildEvent does the recording */
		},
		setSink: () => {
			/* unused */
		},
		setRunActive: () => {
			active = true;
		},
		clearRunActive: () => {
			active = false;
		},
		resetCallIds: () => {
			nextCallId = 0;
		},
		resetAnchor: () => {
			/* unused */
		},
		anchorNs: () => 0n,
		tsUs: () => 0,
		rebind: () => {
			/* unused */
		},
		// marshal/arg fields are not invoked by createSandboxContext;
		// satisfy the type with an empty shim so the compiler is happy.
		marshal: {} as unknown as FakeBridge["marshal"],
		arg: {} as unknown as FakeBridge["arg"],
	} satisfies FakeBridge;
	return bridge;
}

describe("ctx.emit — leaf default", () => {
	it("emits a leaf event when type is omitted", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		ctx.emit("system.call", { name: "console.log", input: { args: ["hi"] } });
		expect(bridge.events).toHaveLength(1);
		expect(bridge.events[0]?.type).toBe("leaf");
		expect(bridge.events[0]?.kind).toBe("system.call");
		expect(bridge.events[0]?.name).toBe("console.log");
		expect(bridge.events[0]?.input).toEqual({ args: ["hi"] });
	});

	it("emits a leaf event when type is explicit 'leaf'", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		ctx.emit("user.click", { name: "btn", type: "leaf" });
		expect(bridge.events[0]?.type).toBe("leaf");
	});
});

describe("ctx.emit — open", () => {
	it("returns the minted CallId and emits {open: id}", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const callId = ctx.emit("trigger.request", {
			name: "demo",
			input: { x: 1 },
			type: "open",
		});
		expect(typeof callId).toBe("number");
		expect(bridge.events[0]?.type).toEqual({ open: callId });
	});

	it("each open mints a fresh id", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const a = ctx.emit("system.request", { name: "fetchA", type: "open" });
		const b = ctx.emit("system.request", { name: "fetchB", type: "open" });
		expect(a).not.toBe(b);
		expect(bridge.events[0]?.type).toEqual({ open: a });
		expect(bridge.events[1]?.type).toEqual({ open: b });
	});
});

describe("ctx.emit — close echoes the supplied callId", () => {
	it("emits {close: id} echoing the caller's id", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		ctx.emit("trigger.response", {
			name: "demo",
			output: { ok: true },
			type: { close: 42 },
		});
		expect(bridge.events[0]?.type).toEqual({ close: 42 });
		expect(bridge.events[0]?.output).toEqual({ ok: true });
	});

	it("type-system enforces close.callId is a number, not arbitrary", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		// closes must carry their CallId as a number via `{ close: callId }`.
		// Passing a non-number must be a compile-time error — this guards the
		// structural pairing contract.
		// biome-ignore format: keep on one line so @ts-expect-error matches the offending expression
		// @ts-expect-error - "not-a-number" is not assignable to CallId (number)
		ctx.emit("trigger.response", { name: "demo", type: { close: "not-a-number" } });
	});
});

describe("ctx.request — sync fn", () => {
	it("emits open and close around fn, pairing via callId", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const out = ctx.request(
			"system",
			{ name: "fetch", input: { url: "x" } },
			() => "result",
		);
		expect(out).toBe("result");
		expect(bridge.events).toHaveLength(2);
		expect(bridge.events[0]?.kind).toBe("system.request");
		const openType = bridge.events[0]?.type;
		expect(openType).toMatchObject({ open: expect.any(Number) });
		const openId = (openType as { open: number }).open;
		expect(bridge.events[1]?.kind).toBe("system.response");
		expect(bridge.events[1]?.type).toEqual({ close: openId });
		expect(bridge.events[1]?.output).toBe("result");
	});

	it("emits open and error close on throw, then rethrows", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		expect(() =>
			ctx.request("system", { name: "fail" }, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(bridge.events).toHaveLength(2);
		expect(bridge.events[0]?.kind).toBe("system.request");
		const openId = (bridge.events[0]?.type as { open: number }).open;
		expect(bridge.events[1]?.kind).toBe("system.error");
		expect(bridge.events[1]?.type).toEqual({ close: openId });
		expect(bridge.events[1]?.error).toMatchObject({ message: "boom" });
	});
});

describe("ctx.request — async fn", () => {
	it("emits open synchronously, response after await", async () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const promise = ctx.request("system", { name: "fetch" }, async () => 7);
		// Open already emitted synchronously
		expect(bridge.events).toHaveLength(1);
		expect(bridge.events[0]?.kind).toBe("system.request");
		const result = await promise;
		expect(result).toBe(7);
		expect(bridge.events).toHaveLength(2);
		expect(bridge.events[1]?.kind).toBe("system.response");
		expect(bridge.events[1]?.output).toBe(7);
	});

	it("emits open synchronously, error close on rejection", async () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		await expect(
			ctx.request("system", { name: "fetch" }, async () => {
				throw new Error("network");
			}),
		).rejects.toThrow("network");
		expect(bridge.events).toHaveLength(2);
		expect(bridge.events[1]?.kind).toBe("system.error");
		expect(bridge.events[1]?.error).toMatchObject({ message: "network" });
	});

	it("concurrent requests pair correctly via callId — Promise.all shape", async () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const a = ctx.request("system", { name: "A" }, async () => "A_result");
		const b = ctx.request("system", { name: "B" }, async () => "B_result");
		await Promise.all([a, b]);

		// Two opens, two closes (4 events). Each close pairs to its own open.
		expect(bridge.events).toHaveLength(4);
		const openA = bridge.events[0]?.type as { open: number };
		const openB = bridge.events[1]?.type as { open: number };
		expect(openA.open).not.toBe(openB.open);

		// Both responses should reference the right open id (regardless of
		// which resolved first).
		const closeA = bridge.events.find(
			(e) => e.kind === "system.response" && e.name === "A",
		);
		const closeB = bridge.events.find(
			(e) => e.kind === "system.response" && e.name === "B",
		);
		expect(closeA?.type).toEqual({ close: openA.open });
		expect(closeB?.type).toEqual({ close: openB.open });
	});
});

describe("ctx.emit — present-only payload fields", () => {
	it("omits input/output/error when not provided", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		ctx.emit("system.call", { name: "x" });
		expect("input" in (bridge.events[0] ?? {})).toBe(false);
		expect("output" in (bridge.events[0] ?? {})).toBe(false);
		expect("error" in (bridge.events[0] ?? {})).toBe(false);
	});
});
