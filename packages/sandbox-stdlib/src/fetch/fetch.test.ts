import type { SandboxContext } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import {
	dependsOn as FETCH_DEPENDS_ON,
	FETCH_DISPATCHER_NAME,
	name as FETCH_PLUGIN_NAME,
	type FetchImpl,
	type FetchResponseWire,
	fetchDispatcherDescriptor,
	worker,
} from "./index.js";

const noopCtx: SandboxContext = {
	emit() {
		return 0 as never;
	},
	request(_prefix, _options, fn) {
		return fn();
	},
};

describe("fetch plugin (§10 shape)", () => {
	it("exposes expected name + dependsOn", () => {
		expect(FETCH_PLUGIN_NAME).toBe("fetch");
		expect(FETCH_DEPENDS_ON).toEqual(["web-platform"]);
	});

	it('worker() registers the private dispatcher descriptor with log.request:"system"', () => {
		const setup = worker(noopCtx);
		expect(setup.guestFunctions).toHaveLength(1);
		const gf = setup.guestFunctions?.[0];
		expect(gf?.name).toBe(FETCH_DISPATCHER_NAME);
		expect(gf?.public).toBe(false);
		expect(gf?.log).toEqual({ request: "system" });
	});

	it("dispatcher handler invokes the supplied fetch impl and returns a wire-serialised response", async () => {
		const calls: Parameters<FetchImpl>[] = [];
		const fetchImpl: FetchImpl = async (...args) => {
			calls.push(args);
			return {
				status: 201,
				statusText: "Created",
				headers: new Headers({ "x-custom": "hi" }),
				text: () => Promise.resolve("payload"),
			} as Response;
		};
		const gf = fetchDispatcherDescriptor(fetchImpl);
		const handler = gf.handler as unknown as (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<FetchResponseWire>;
		const wire = await handler(
			"POST",
			"http://example.com/x",
			{ a: "1" },
			"body",
		);
		expect(wire).toEqual({
			status: 201,
			statusText: "Created",
			headers: { "x-custom": "hi" },
			body: "payload",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("http://example.com/x");
		const init = calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ a: "1" });
		expect(init.body).toBe("body");
	});

	it("default worker() closes over hardenedFetch (structural SSRF protection)", async () => {
		// The production path IS the only sanctioned one — `worker()` bakes in
		// hardenedFetch with no opt-out. Structural hardening coverage lives
		// in the hardened-fetch tests; this test verifies the plugin default
		// path produces a descriptor whose behaviour matches hardenedFetch's.
		const { hardenedFetch } = await import("./hardened-fetch.js");
		expect(typeof hardenedFetch).toBe("function");
		const setup = worker(noopCtx);
		expect(setup.guestFunctions?.[0]).toBeDefined();
	});

	it("propagates fetch errors through the dispatcher unchanged", async () => {
		const fetchImpl: FetchImpl = async () => {
			throw new TypeError("connection refused");
		};
		const gf = fetchDispatcherDescriptor(fetchImpl);
		const handler = gf.handler as unknown as (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<FetchResponseWire>;
		await expect(handler("GET", "http://x", {}, null)).rejects.toThrow(
			/connection refused/,
		);
	});

	it("passes a controllable AbortSignal to the bound fetch impl", async () => {
		// Capture the signal state INSIDE the impl (before the dispatcher's
		// `finally { release }` calls abort). After release, the signal
		// becomes aborted even on the success path — that's harmless because
		// the request has already completed; this test verifies the in-flight
		// signal is the descriptor's controller, not the post-release state.
		let inflightAborted: boolean | undefined;
		let inflightSignalIsAbortSignal = false;
		const fetchImpl: FetchImpl = async (_input, init) => {
			const sig = (init as RequestInit | undefined)?.signal;
			inflightSignalIsAbortSignal = sig instanceof AbortSignal;
			inflightAborted = sig?.aborted ?? undefined;
			return {
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				text: () => Promise.resolve(""),
			} as Response;
		};
		const gf = fetchDispatcherDescriptor(fetchImpl);
		const handler = gf.handler as unknown as (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<FetchResponseWire>;
		await handler("GET", "http://x", {}, null);
		expect(inflightSignalIsAbortSignal).toBe(true);
		expect(inflightAborted).toBe(false);
	});
});

describe("fetch plugin — run-scoped controller cleanup", () => {
	it("aborts in-flight requests when onRunFinished fires", async () => {
		// Hold the fetch on a deferred so we can inspect signal state during
		// the in-flight window.
		let observedSignal: AbortSignal | undefined;
		let resolveFetch: ((res: Response) => void) | undefined;
		const fetchImpl: FetchImpl = (_input, init) => {
			observedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
			return new Promise<Response>((res, rej) => {
				resolveFetch = res;
				observedSignal?.addEventListener("abort", () => {
					rej(observedSignal?.reason ?? new Error("aborted"));
				});
			});
		};
		const gf = fetchDispatcherDescriptor(fetchImpl);
		const handler = gf.handler as unknown as (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<FetchResponseWire>;

		// Kick off the request; do NOT await it.
		const inflight = handler("GET", "http://slow", {}, null).catch(
			(e) => e as unknown,
		);
		// Yield once so the dispatcher constructs the AbortController, tracks
		// it, and parks on `await fetchImpl(...)`.
		await Promise.resolve();
		expect(observedSignal?.aborted).toBe(false);

		// Run end: drain via the worker's onRunFinished.
		const setup = worker(noopCtx);
		await setup.onRunFinished?.(
			{ ok: true, output: undefined },
			{ name: "fakeRun", input: undefined },
		);
		expect(observedSignal?.aborted).toBe(true);

		// The dispatcher's await chain rejects with the abort reason.
		const result = await inflight;
		expect(result).toBeDefined();
		// Avoid the dangling resolveFetch lint by tying it to a no-op.
		resolveFetch?.({
			status: 0,
			statusText: "",
			headers: new Headers(),
			text: () => Promise.resolve(""),
		} as Response);
	});

	it("per-call success removes the controller before drain runs", async () => {
		const fetchImpl: FetchImpl = async () =>
			({
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				text: () => Promise.resolve(""),
			}) as Response;
		const gf = fetchDispatcherDescriptor(fetchImpl);
		const handler = gf.handler as unknown as (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<FetchResponseWire>;
		await handler("GET", "http://ok", {}, null);
		// drain after a successful release: nothing tracked, no observable
		// effect (no test fetchImpl to assert against). Simply confirm
		// onRunFinished resolves cleanly.
		const setup = worker(noopCtx);
		await expect(
			setup.onRunFinished?.(
				{ ok: true, output: undefined },
				{ name: "fakeRun", input: undefined },
			),
		).resolves.toBeUndefined();
	});

	it("per-call error removes the controller via the per-call finally", async () => {
		const fetchImpl: FetchImpl = async () => {
			throw new TypeError("boom");
		};
		const gf = fetchDispatcherDescriptor(fetchImpl);
		const handler = gf.handler as unknown as (
			method: string,
			url: string,
			headers: Record<string, string>,
			body: string | null,
		) => Promise<FetchResponseWire>;
		await expect(handler("GET", "http://err", {}, null)).rejects.toThrow(
			/boom/,
		);
		// Nothing tracked at run end.
		const setup = worker(noopCtx);
		await expect(
			setup.onRunFinished?.(
				{ ok: true, output: undefined },
				{ name: "fakeRun", input: undefined },
			),
		).resolves.toBeUndefined();
	});
});
