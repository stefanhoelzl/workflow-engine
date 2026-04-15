import type {
	MethodMap,
	RunResult,
	Sandbox,
	SandboxFactory,
	SandboxOptions,
} from "@workflow-engine/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { createEventBus, type RuntimeEvent } from "../event-bus/index.js";
import { createWorkQueue } from "../event-bus/work-queue.js";
import { createEventSource } from "../event-source.js";
import { createScheduler } from "./scheduler.js";

const passthroughSchema = { parse: (d: unknown) => d };

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "order.received",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "test-trigger",
		...overrides,
	} as RuntimeEvent;
}

function createTestSetup() {
	const emitted: RuntimeEvent[] = [];
	const workQueue = createWorkQueue();
	const collector = {
		async handle(event: RuntimeEvent) {
			emitted.push(event);
		},
		async bootstrap() {
			/* no-op */
		},
	};
	const bus = createEventBus([workQueue, collector]);
	const source = createEventSource(
		{
			events: {
				"order.received": passthroughSchema,
				"order.validated": passthroughSchema,
			},
		},
		bus,
	);
	const stubContextFactory = (
		event: RuntimeEvent,
		_actionName: string,
		env: Record<string, string>,
	): ActionContext => new ActionContext(event, env);

	return { bus, workQueue, emitted, source, stubContextFactory };
}

type RunHandler = (
	name: string,
	ctx: unknown,
	extraMethods?: MethodMap,
) => Promise<RunResult>;

function asSandboxFactory(
	createFn: (
		source: string,
		methods: MethodMap,
		opts?: SandboxOptions,
	) => Promise<Sandbox>,
): SandboxFactory {
	return {
		create: (source, opts) => createFn(source, {}, opts),
		dispose: async () => {
			/* no-op */
		},
	};
}

function createMockSandboxFactory(handler?: RunHandler): SandboxFactory {
	return asSandboxFactory(async () => ({
		run:
			handler ??
			(async () => ({ ok: true as const, result: undefined, logs: [] })),
		dispose: () => {
			/* no-op */
		},
		onDied: () => {
			/* no-op */
		},
	}));
}

describe("createScheduler", () => {
	describe("directed events", () => {
		it("executes matching action and emits done", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const runSpy = vi.fn<RunHandler>(async () => ({
				ok: true as const,
				result: undefined,
				logs: [],
			}));
			const sandboxFactory = createMockSandboxFactory(runSpy);
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			const event = makeEvent({ targetAction: "parseOrder" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(runSpy).toHaveBeenCalledTimes(1);
			expect(runSpy.mock.calls.at(0)?.at(0)).toBe("default");

			const states = emitted.map((e) => e.state);
			expect(states).toContain("processing");
			expect(states).toContain("done");
		});

		it("emits failed when action throws", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const sandboxFactory = createMockSandboxFactory(async () => ({
				ok: false as const,
				error: { message: "boom", stack: "at test:1" },
				logs: [],
			}));
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => { throw new Error('boom') }",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const failed = emitted.find(
				(e) => e.state === "done" && e.result === "failed",
			);
			expect(failed).toBeDefined();
			expect(
				failed?.state === "done" && failed.result === "failed"
					? failed.error
					: undefined,
			).toEqual({ message: "boom", stack: "at test:1" });
		});

		it("emits skipped when no action matches directed event", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const sandboxFactory = createMockSandboxFactory();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			await bus.emit(makeEvent({ targetAction: "nonexistent" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const skipped = emitted.find(
				(e) => e.state === "done" && e.result === "skipped",
			);
			expect(skipped).toBeDefined();
		});

		it("actions receive guest ctx with event data", async () => {
			const { bus, workQueue, source, stubContextFactory } = createTestSetup();
			let receivedCtx: unknown;
			const sandboxFactory = createMockSandboxFactory(async (_name, ctx) => {
				receivedCtx = ctx;
				return { ok: true as const, result: undefined, logs: [] };
			});
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			const event = makeEvent({
				targetAction: "parseOrder",
				correlationId: "corr_xyz",
			});
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(receivedCtx).toBeDefined();
			// Guest-facing ctx: event is { name, payload } (no correlationId etc.)
			// but env exists. Correlation information is in the RuntimeEvent used
			// by the scheduler's own emit-closure, not in the ctx.
			expect((receivedCtx as { event: { name: string } }).event.name).toBe(
				"order.received",
			);
		});
	});

	describe("sandbox reuse", () => {
		it("reuses the same sandbox across multiple events for the same source", async () => {
			const { bus, workQueue, source, stubContextFactory } = createTestSetup();
			// Track how many unique Sandbox instances are constructed.
			// The real factory caches by source; this stub mimics that.
			let constructionCount = 0;
			const cached = new Map<string, Sandbox>();
			const sandboxFactory: SandboxFactory = {
				create: async (source: string): Promise<Sandbox> => {
					const existing = cached.get(source);
					if (existing) {
						return existing;
					}
					constructionCount += 1;
					const sb: Sandbox = {
						run: async () => ({
							ok: true as const,
							result: undefined,
							logs: [],
						}),
						dispose: () => {
							/* no-op */
						},
						onDied: () => {
							/* no-op */
						},
					};
					cached.set(source, sb);
					return sb;
				},
				dispose: async () => {
					/* no-op */
				},
			};
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));
			await bus.emit(makeEvent({ targetAction: "parseOrder" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 20));
			await scheduler.stop();
			await started;

			// Only one sandbox constructed across two events.
			expect(constructionCount).toBe(1);
		});
	});

	describe("emit extra-method", () => {
		it("host emit closure calls source.derive for the current event", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			let capturedEmit:
				| ((type: string, payload: unknown) => Promise<void>)
				| undefined;
			const sandboxFactory = createMockSandboxFactory(
				async (_name, _ctx, extras) => {
					// Host has installed `emit` as an extraMethod on this run.
					// biome-ignore lint/suspicious/noExplicitAny: test capture of extraMethods shape
					capturedEmit = (extras as any)?.emit;
					return { ok: true as const, result: undefined, logs: [] };
				},
			);
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			const event = makeEvent({
				targetAction: "parseOrder",
				correlationId: "corr_preserve",
			});
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(capturedEmit).toBeDefined();
			// Now invoke the captured emit as if the guest had called emit() mid-run.
			await capturedEmit?.("order.validated", { ok: true });

			const derived = emitted.find(
				(e) => e.type === "order.validated" && e.parentEventId === event.id,
			);
			expect(derived).toBeDefined();
			expect(derived?.correlationId).toBe("corr_preserve");
		});
	});

	describe("fan-out", () => {
		it("creates targeted copies for each matching action", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const runSpy = vi.fn<RunHandler>(async () => ({
				ok: true as const,
				result: undefined,
				logs: [],
			}));
			const sandboxFactory = createMockSandboxFactory(runSpy);
			const actions: Action[] = [
				{
					name: "parseOrder",
					on: "order.received",
					env: {},
					source: "export default async (ctx) => {}",
					exportName: "default",
				},
				{
					name: "sendEmail",
					on: "order.received",
					env: {},
					source: "export default async (ctx) => {}",
					exportName: "default",
				},
			];
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions },
				stubContextFactory,
				{ sandboxFactory },
			);

			const event = makeEvent();
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 50));
			await scheduler.stop();
			await started;

			expect(runSpy).toHaveBeenCalledTimes(2);

			// Original goes through processing → done
			const originalStates = emitted
				.filter((e) => e.id === event.id)
				.map((e) => e.state);
			expect(originalStates).toContain("processing");
			expect(originalStates).toContain("done");

			// Forked events have parentEventId pointing to original
			const forked = emitted.filter(
				(e) => e.state === "pending" && e.parentEventId === event.id,
			);
			expect(forked).toHaveLength(2);
			const targets = forked.map((e) => e.targetAction).sort();
			expect(targets).toEqual(["parseOrder", "sendEmail"]);
		});

		it("emits skipped when no actions match the event type", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const sandboxFactory = createMockSandboxFactory();
			const action: Action = {
				name: "parseOrder",
				on: "order.validated",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			const event = makeEvent({ type: "unknown.event" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const skipped = emitted.find(
				(e) =>
					e.id === event.id && e.state === "done" && e.result === "skipped",
			);
			expect(skipped).toBeDefined();
		});

		it("preserves correlationId in forked events", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const sandboxFactory = createMockSandboxFactory();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			const event = makeEvent({ correlationId: "corr_preserved" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const forked = emitted.find(
				(e) => e.state === "pending" && e.parentEventId === event.id,
			);
			expect(forked?.correlationId).toBe("corr_preserved");
		});

		it("only fans out to actions matching the event type", async () => {
			const { bus, workQueue, source, stubContextFactory } = createTestSetup();
			const matchingRun = vi.fn<RunHandler>(async () => ({
				ok: true as const,
				result: undefined,
				logs: [],
			}));
			const sandboxFactory = createMockSandboxFactory(matchingRun);
			const actions: Action[] = [
				{
					name: "parseOrder",
					on: "order.received",
					env: {},
					source: "export default async (ctx) => {}",
					exportName: "default",
				},
				{
					name: "updateInventory",
					on: "order.shipped",
					env: {},
					source: "export default async (ctx) => {}",
					exportName: "default",
				},
			];
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions },
				stubContextFactory,
				{ sandboxFactory },
			);

			await bus.emit(makeEvent());

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			// Only parseOrder should be run (via fan-out + directed event)
			expect(matchingRun).toHaveBeenCalledTimes(1);
		});
	});

	describe("start and stop", () => {
		it("start and stop control the loop", async () => {
			const { bus, workQueue, source, stubContextFactory } = createTestSetup();
			const runSpy = vi.fn<RunHandler>(async () => ({
				ok: true as const,
				result: undefined,
				logs: [],
			}));
			const sandboxFactory = createMockSandboxFactory(runSpy);
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			const started = scheduler.start();
			await scheduler.stop();
			await started;

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));
			await new Promise((r) => setTimeout(r, 10));

			expect(runSpy).not.toHaveBeenCalled();
		});
	});

	describe("bridge logs on action events", () => {
		it("attaches sandbox logs to the done transition", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const logs = [
				{
					method: "console.log" as const,
					args: ["hello"],
					status: "ok" as const,
					ts: 1,
				},
				{
					method: "xhr.send" as const,
					args: ["GET", "https://example.com"],
					status: "ok" as const,
					ts: 2,
					durationMs: 5,
				},
			];
			const sandboxFactory = createMockSandboxFactory(async () => ({
				ok: true as const,
				result: undefined,
				logs,
			}));
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => {}",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));
			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const done = emitted.find(
				(e) => e.state === "done" && e.result === "succeeded",
			);
			expect(done).toBeDefined();
			expect(done?.logs).toEqual(logs);
		});

		it("attaches logs even when the action fails", async () => {
			const { bus, workQueue, emitted, source, stubContextFactory } =
				createTestSetup();
			const logs = [
				{
					method: "console.error" as const,
					args: ["boom"],
					status: "ok" as const,
					ts: 1,
				},
			];
			const sandboxFactory = createMockSandboxFactory(async () => ({
				ok: false as const,
				error: { message: "boom", stack: "at x:1" },
				logs,
			}));
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				env: {},
				source: "export default async (ctx) => { throw new Error('boom') }",
				exportName: "default",
			};
			const scheduler = createScheduler(
				workQueue,
				source,
				{ actions: [action] },
				stubContextFactory,
				{ sandboxFactory },
			);

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));
			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const failed = emitted.find(
				(e) => e.state === "done" && e.result === "failed",
			);
			expect(failed?.logs).toEqual(logs);
		});
	});
});
