import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge-factory.js";
import { createSandboxContext } from "./sandbox-context.js";

interface RecordedEvent {
	readonly kind: string;
	readonly name: string;
	readonly seq: number;
	readonly ref: number | null;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: unknown;
}

/**
 * Minimal Bridge stand-in exposing only the surface createSandboxContext uses
 * (buildEvent, emit, nextSeq, currentRef, pushRef, popRef). The real bridge
 * depends on a QuickJS VM, which isn't available in pure unit tests — this
 * fake lets us exercise ctx.emit / ctx.request semantics in isolation while
 * preserving the real seq/ref-stack invariants.
 */
interface FakeBridge extends Bridge {
	readonly events: RecordedEvent[];
	readonly refStack: number[];
	nextSeqValue(): number;
}

function createFakeBridge(): FakeBridge {
	const events: RecordedEvent[] = [];
	const refStack: number[] = [];
	let seq = 0;
	// Partial Bridge — we only need the methods sandbox-context calls.
	const bridge = {
		events,
		refStack,
		nextSeqValue: () => seq,
		nextSeq: () => ++seq,
		currentRef: () => refStack.at(-1) ?? null,
		pushRef: (s: number) => {
			refStack.push(s);
		},
		popRef: () => refStack.pop() ?? null,
		// biome-ignore lint/complexity/useMaxParams: Bridge.buildEvent signature has 5 params (kind, seq, ref, name, extra) — fake must match it
		buildEvent: (
			kind: string,
			seqValue: number,
			ref: number | null,
			name: string,
			extra: { input?: unknown; output?: unknown; error?: unknown },
		): InvocationEvent | null => {
			// Real bridge returns null if no runContext; fake always returns an
			// event so tests can inspect emission order. That matches design
			// intent — ctx users shouldn't care about runContext gating.
			return {
				kind: kind as InvocationEvent["kind"],
				id: "test",
				seq: seqValue,
				ref,
				at: "1970-01-01T00:00:00.000Z",
				ts: 0,
				owner: "t",
				repo: "r",
				workflow: "w",
				workflowSha: "s",
				name,
				...(extra.input === undefined ? {} : { input: extra.input }),
				...(extra.output === undefined ? {} : { output: extra.output }),
				...(extra.error === undefined
					? {}
					: {
							error: extra.error as {
								message: string;
								stack: string;
								issues?: unknown;
							},
						}),
			};
		},
		emit: (event: InvocationEvent) => {
			events.push({
				kind: event.kind,
				name: event.name,
				seq: event.seq,
				ref: event.ref,
				...(event.input === undefined ? {} : { input: event.input }),
				...(event.output === undefined ? {} : { output: event.output }),
				...(event.error === undefined ? {} : { error: event.error }),
			});
		},
	} as unknown as FakeBridge;
	return bridge;
}

describe("ctx.emit — leaf semantics (no options)", () => {
	it("emits with ref = current stack top", () => {
		const bridge = createFakeBridge();
		bridge.pushRef(7);
		const ctx = createSandboxContext(bridge);
		ctx.emit("timer.set", "setTimeout", { input: { delay: 100 } });
		expect(bridge.events).toHaveLength(1);
		expect(bridge.events[0]).toMatchObject({
			kind: "timer.set",
			name: "setTimeout",
			ref: 7,
			input: { delay: 100 },
		});
	});

	it("emits with ref null when stack is empty", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		ctx.emit("uncaught-error", "reportError", { input: "boom" });
		expect(bridge.events).toHaveLength(1);
		expect(bridge.events[0]?.ref).toBeNull();
	});

	it("does not modify the refStack", () => {
		const bridge = createFakeBridge();
		bridge.pushRef(1);
		const ctx = createSandboxContext(bridge);
		const before = [...bridge.refStack];
		ctx.emit("console.log", "log", { input: ["hi"] });
		expect(bridge.refStack).toEqual(before);
	});
});

describe("ctx.emit — createsFrame", () => {
	it("emits with parent ref then pushes this event's seq", () => {
		const bridge = createFakeBridge();
		bridge.pushRef(5);
		const ctx = createSandboxContext(bridge);
		ctx.emit(
			"trigger.request",
			"run",
			{ input: { foo: 1 } },
			{ createsFrame: true },
		);
		const evt = bridge.events[0];
		expect(evt?.ref).toBe(5);
		expect(evt?.kind).toBe("trigger.request");
		// Stack now has this event's seq on top.
		expect(bridge.refStack.at(-1)).toBe(evt?.seq);
	});
});

describe("ctx.emit — closesFrame", () => {
	it("emits with current stack top as ref then pops", () => {
		const bridge = createFakeBridge();
		bridge.pushRef(3);
		bridge.pushRef(9);
		const ctx = createSandboxContext(bridge);
		ctx.emit(
			"trigger.response",
			"run",
			{ input: { foo: 1 }, output: { ok: true } },
			{ closesFrame: true },
		);
		expect(bridge.events[0]?.ref).toBe(9);
		expect(bridge.refStack).toEqual([3]);
	});
});

describe("ctx.emit — both flags (treated as leaf)", () => {
	it("does not push or pop when both createsFrame and closesFrame are true", () => {
		const bridge = createFakeBridge();
		bridge.pushRef(2);
		const ctx = createSandboxContext(bridge);
		ctx.emit(
			"instant.span",
			"inst",
			{},
			{ createsFrame: true, closesFrame: true },
		);
		expect(bridge.refStack).toEqual([2]);
		expect(bridge.events[0]?.ref).toBe(2);
	});
});

describe("ctx.request — sync fn", () => {
	it("emits request + response around the function body", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const out = ctx.request(
			"fetch",
			"GET /api",
			{ input: { url: "/api" } },
			() => ({ status: 200 }),
		);
		expect(out).toEqual({ status: 200 });
		expect(bridge.events.map((e) => e.kind)).toEqual([
			"fetch.request",
			"fetch.response",
		]);
		const [req, res] = bridge.events;
		expect(res?.ref).toBe(req?.seq);
		expect(res?.output).toEqual({ status: 200 });
	});

	it("leaves refStack balanced on sync success", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const before = bridge.refStack.length;
		ctx.request("x", "y", { input: 1 }, () => 2);
		expect(bridge.refStack.length).toBe(before);
	});

	it("emits request + error and rethrows on sync throw", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const boom = new Error("boom");
		expect(() =>
			ctx.request("fetch", "fail", { input: null }, () => {
				throw boom;
			}),
		).toThrow(boom);
		expect(bridge.events.map((e) => e.kind)).toEqual([
			"fetch.request",
			"fetch.error",
		]);
		const err = bridge.events[1];
		expect(err?.error).toMatchObject({ message: "boom" });
	});

	it("leaves refStack balanced on sync throw", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const before = bridge.refStack.length;
		try {
			ctx.request("x", "y", {}, () => {
				throw new Error("stack-balance");
			});
		} catch {
			/* expected */
		}
		expect(bridge.refStack.length).toBe(before);
	});
});

describe("ctx.request — async fn", () => {
	it("emits request synchronously and response after resolve", async () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const promise = ctx.request(
			"fetch",
			"slow",
			{ input: { url: "/" } },
			async () => {
				await Promise.resolve();
				return { body: "ok" };
			},
		);
		// Request is emitted synchronously (before the promise resolves).
		expect(bridge.events.map((e) => e.kind)).toEqual(["fetch.request"]);
		const out = await promise;
		expect(out).toEqual({ body: "ok" });
		expect(bridge.events.map((e) => e.kind)).toEqual([
			"fetch.request",
			"fetch.response",
		]);
		const [req, res] = bridge.events;
		expect(res?.ref).toBe(req?.seq);
	});

	it("emits request + error on async rejection and rethrows", async () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const boom = new Error("later");
		await expect(
			ctx.request("x", "fail", {}, async () => {
				await Promise.resolve();
				throw boom;
			}),
		).rejects.toThrow(boom);
		expect(bridge.events.map((e) => e.kind)).toEqual(["x.request", "x.error"]);
	});

	it("captures reqSeq so response/error parent correctly after stack changes mid-await", async () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const outer = ctx.request("outer", "A", {}, async () => {
			// Nested ctx.request pushes/pops during the outer's await.
			await ctx.request("inner", "B", {}, async () => {
				await Promise.resolve();
				return 1;
			});
			return "done";
		});
		await outer;
		const byKind = bridge.events.map((e) => e.kind);
		expect(byKind).toEqual([
			"outer.request",
			"inner.request",
			"inner.response",
			"outer.response",
		]);
		const [outReq, inReq, inRes, outRes] = bridge.events;
		// inner.request parents to outer.request
		expect(inReq?.ref).toBe(outReq?.seq);
		// inner.response parents to inner.request
		expect(inRes?.ref).toBe(inReq?.seq);
		// outer.response parents to outer.request
		expect(outRes?.ref).toBe(outReq?.seq);
	});
});

describe("ctx — seq and ref are internal", () => {
	it("emit returns undefined (no seq leak)", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const result = ctx.emit("log", "x", {});
		expect(result).toBeUndefined();
	});

	it("request returns the handler's result unchanged", () => {
		const bridge = createFakeBridge();
		const ctx = createSandboxContext(bridge);
		const out = ctx.request("x", "y", {}, () => 42);
		expect(out).toBe(42);
	});
});
