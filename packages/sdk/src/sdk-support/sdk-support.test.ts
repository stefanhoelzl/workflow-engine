import type {
	Callable,
	DepsMap,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
	SDK_DISPATCH_DESCRIPTOR,
	dependsOn as SDK_SUPPORT_DEPENDS_ON,
	name as SDK_SUPPORT_PLUGIN_NAME,
	worker,
} from "./index.js";

interface RequestRecord {
	prefix: string;
	name: string;
	extra: { input?: unknown };
	result?: unknown;
	error?: unknown;
}

interface EventRecord {
	kind: string;
	name: string;
	extra: unknown;
}

function recordingContext(): SandboxContext & {
	readonly events: EventRecord[];
	readonly requests: RequestRecord[];
} {
	const events: EventRecord[] = [];
	const requests: RequestRecord[] = [];
	return {
		events,
		requests,
		emit(kind, name, extra) {
			events.push({ kind, name, extra });
		},
		request(prefix, name, extra, fn) {
			const entry: RequestRecord = { prefix, name, extra };
			requests.push(entry);
			try {
				const r = fn();
				if (r instanceof Promise) {
					return r.then(
						(v) => {
							entry.result = v;
							return v;
						},
						(e) => {
							entry.error = e;
							throw e;
						},
					);
				}
				entry.result = r;
				return r;
			} catch (e) {
				entry.error = e;
				throw e;
			}
		},
	};
}

function makeCallableDouble(
	impl: (...args: readonly unknown[]) => unknown,
): Callable & { disposed: boolean } {
	let disposed = false;
	const invoke = (async (...args: readonly unknown[]) => {
		if (disposed) {
			throw new Error("callable disposed");
		}
		return impl(...args);
	}) as Callable & { disposed: boolean };
	invoke.dispose = () => {
		disposed = true;
		invoke.disposed = true;
	};
	invoke.disposed = false;
	return invoke;
}

function makeHostCallActionDeps(
	validate?: (name: string, input: unknown) => void,
): DepsMap {
	return {
		"host-call-action": {
			validateAction:
				validate ??
				(() => {
					/* no-op: always valid */
				}),
		},
	};
}

describe("sdk-support plugin (§10 shape)", () => {
	it("exposes expected name + dependsOn", () => {
		expect(SDK_SUPPORT_PLUGIN_NAME).toBe("sdk-support");
		expect(SDK_SUPPORT_DEPENDS_ON).toEqual(["host-call-action"]);
	});

	it("worker() registers a private __sdkDispatchAction descriptor", () => {
		const ctx = recordingContext();
		const setup = worker(ctx, makeHostCallActionDeps());
		expect(setup.guestFunctions).toHaveLength(1);
		const gf = setup.guestFunctions?.[0];
		expect(gf?.name).toBe(SDK_DISPATCH_DESCRIPTOR);
		expect(gf?.public).toBe(false);
		expect(gf?.log).toEqual({ request: "action" });
		expect(typeof gf?.logName).toBe("function");
		expect(typeof gf?.logInput).toBe("function");
	});

	it("throws a descriptive error when host-call-action does not export validateAction", () => {
		expect(() => worker(recordingContext(), {} as DepsMap)).toThrow(
			/did not export validateAction/,
		);
	});

	it("logName extracts the action name from args[0]", () => {
		const setup = worker(recordingContext(), makeHostCallActionDeps());
		const gf = setup.guestFunctions?.[0];
		expect(gf?.logName?.(["processOrder", { foo: "bar" }, {}, {}])).toBe(
			"processOrder",
		);
	});

	it("logInput extracts the action input from args[1], omitting the Callable args", () => {
		const setup = worker(recordingContext(), makeHostCallActionDeps());
		const gf = setup.guestFunctions?.[0];
		expect(gf?.logInput?.(["processOrder", { foo: "bar" }, {}, {}])).toEqual({
			foo: "bar",
		});
	});

	it("handler validates input, invokes handler + completer, disposes callables, returns parsed output", async () => {
		const validate = vi.fn();
		const handlerCallable = makeCallableDouble(async (input) => ({
			rawResult: 42,
			echoed: input,
		}));
		const completerCallable = makeCallableDouble((raw) => ({
			parsed: true,
			from: raw,
		}));

		const setup = worker(recordingContext(), makeHostCallActionDeps(validate));
		const gf = setup.guestFunctions?.[0];
		if (!gf) {
			throw new Error("expected a descriptor");
		}
		const handler = gf.handler as unknown as (
			name: string,
			input: unknown,
			handler: Callable,
			completer: Callable,
		) => Promise<unknown>;

		const out = await handler(
			"processOrder",
			{ foo: "bar" },
			handlerCallable,
			completerCallable,
		);

		expect(validate).toHaveBeenCalledWith("processOrder", { foo: "bar" });
		expect(out).toEqual({
			parsed: true,
			from: { rawResult: 42, echoed: { foo: "bar" } },
		});
		expect(handlerCallable.disposed).toBe(true);
		expect(completerCallable.disposed).toBe(true);
	});

	it("propagates the original handler throw and still disposes both callables", async () => {
		const handlerCallable = makeCallableDouble(async () => {
			throw new Error("handler boom");
		});
		const completerCallable = makeCallableDouble(() => {
			throw new Error("completer should not be called");
		});

		const setup = worker(recordingContext(), makeHostCallActionDeps());
		const gf = setup.guestFunctions?.[0];
		if (!gf) {
			throw new Error("expected a descriptor");
		}
		const handler = gf.handler as unknown as (
			name: string,
			input: unknown,
			handler: Callable,
			completer: Callable,
		) => Promise<unknown>;

		await expect(
			handler(
				"processOrder",
				{ foo: "bar" },
				handlerCallable,
				completerCallable,
			),
		).rejects.toThrow(/handler boom/);
		expect(handlerCallable.disposed).toBe(true);
		expect(completerCallable.disposed).toBe(true);
	});

	it("propagates validateAction throws without invoking handler or completer, and still disposes callables", async () => {
		const handlerImpl = vi.fn();
		const completerImpl = vi.fn();
		const handlerCallable = makeCallableDouble(handlerImpl);
		const completerCallable = makeCallableDouble(completerImpl);

		const validateError = new Error("schema mismatch");
		(validateError as Error & { issues?: unknown }).issues = [
			{ path: "foo", message: "required" },
		];
		const validate = vi.fn(() => {
			throw validateError;
		});

		const setup = worker(recordingContext(), makeHostCallActionDeps(validate));
		const gf = setup.guestFunctions?.[0];
		if (!gf) {
			throw new Error("expected a descriptor");
		}
		const handler = gf.handler as unknown as (
			name: string,
			input: unknown,
			handler: Callable,
			completer: Callable,
		) => Promise<unknown>;

		await expect(
			handler(
				"processOrder",
				{ bad: true },
				handlerCallable,
				completerCallable,
			),
		).rejects.toThrow(/schema mismatch/);
		expect(handlerImpl).not.toHaveBeenCalled();
		expect(completerImpl).not.toHaveBeenCalled();
		expect(handlerCallable.disposed).toBe(true);
		expect(completerCallable.disposed).toBe(true);
	});

	it("emits a source blob that installs a locked __sdk via Object.defineProperty and freezes the inner object", () => {
		const setup = worker(recordingContext(), makeHostCallActionDeps());
		expect(setup.source).toBeTruthy();
		const source = setup.source ?? "";
		expect(source).toContain('Object.defineProperty(globalThis, "__sdk"');
		expect(source).toContain("writable: false");
		expect(source).toContain("configurable: false");
		expect(source).toContain("Object.freeze");
		expect(source).toContain('"__sdkDispatchAction"');
	});
});
