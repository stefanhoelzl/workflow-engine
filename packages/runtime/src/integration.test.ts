import type {
	MethodMap,
	RunResult,
	Sandbox,
	SandboxOptions,
} from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import type { Action } from "./actions/index.js";
import { createActionContext } from "./context/index.js";
import { createEventBus, type RuntimeEvent } from "./event-bus/index.js";
import { createWorkQueue } from "./event-bus/work-queue.js";
import { createEventSource } from "./event-source.js";
import { createScheduler } from "./services/scheduler.js";
import { createApp } from "./services/server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

const passthroughSchema = { parse: (d: unknown) => d };
const defaultSchemas: Record<string, { parse(data: unknown): unknown }> = {
	"webhook.order": passthroughSchema,
	"order.validated": passthroughSchema,
	stop: passthroughSchema,
};

const CORR_PREFIX = /^corr_/;

interface RunCall {
	source: string;
	name: string;
	ctx: {
		event: { name: string; payload: unknown };
		env: Record<string, string>;
	};
	extras?: MethodMap;
}

describe("integration: HTTP → trigger → fan-out → action → emit → fan-out", () => {
	it("processes a full chaining pipeline with fan-out after emit", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});

		const workQueue = createWorkQueue();
		const emitted: RuntimeEvent[] = [];
		const collector = {
			async handle(event: RuntimeEvent) {
				emitted.push(event);
			},
			async bootstrap() {
				/* no-op */
			},
		};
		const bus = createEventBus([workQueue, collector]);
		const source = createEventSource({ events: defaultSchemas }, bus);
		const createContext = createActionContext();

		const runCalls: RunCall[] = [];
		const sandboxFactory = async (
			actionSource: string,
			_methods: MethodMap,
			_opts?: SandboxOptions,
		): Promise<Sandbox> => ({
			run: async (name, ctx, extras) => {
				const call: RunCall = {
					source: actionSource,
					name,
					ctx: ctx as RunCall["ctx"],
				};
				if (extras) {
					call.extras = extras;
				}
				runCalls.push(call);
				// Simulate the validateOrder action emitting — invoke the per-run
				// emit host method installed by the scheduler.
				if (actionSource.includes("validateOrder") && extras?.emit) {
					await extras.emit(
						"order.validated",
						(ctx as RunCall["ctx"]).event.payload,
					);
				}
				return { ok: true, result: undefined, logs: [] } satisfies RunResult;
			},
			dispose: () => {
				/* no-op */
			},
		});

		const actions: Action[] = [
			{
				name: "validateOrder",
				on: "webhook.order",
				env: {},
				source: "export default async (ctx) => { /* validateOrder */ }",
				exportName: "default",
			},
			{
				name: "fulfillOrder",
				on: "order.validated",
				env: {},
				source: "export default async (ctx) => { /* fulfillOrder */ }",
				exportName: "default",
			},
			{
				name: "notifyCustomer",
				on: "order.validated",
				env: {},
				source: "export default async (ctx) => { /* notifyCustomer */ }",
				exportName: "default",
			},
		];

		const scheduler = createScheduler(
			workQueue,
			source,
			{ actions },
			createContext,
			{ sandboxFactory },
		);
		scheduler.start();

		const app = createApp(
			httpTriggerMiddleware({ triggerRegistry: registry }, source),
		);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });

		await new Promise((r) => setTimeout(r, 100));

		await scheduler.stop();

		// validateOrder + fulfillOrder + notifyCustomer
		expect(runCalls).toHaveLength(3);

		const fulfillCall = runCalls.find((c) => c.source.includes("fulfillOrder"));
		const notifyCall = runCalls.find((c) =>
			c.source.includes("notifyCustomer"),
		);
		expect(fulfillCall).toBeDefined();
		expect(notifyCall).toBeDefined();

		// Guest ctx includes event name + payload; correlation IS NOT on guest ctx.
		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const fulfill = fulfillCall!;
		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const notify = notifyCall!;

		expect(fulfill.ctx.event.name).toBe("order.validated");
		expect(notify.ctx.event.name).toBe("order.validated");

		// Payload includes the full HTTP context shape
		expect(fulfill.ctx.event.payload).toHaveProperty("body");
		expect(fulfill.ctx.event.payload).toHaveProperty("headers");
		expect(fulfill.ctx.event.payload).toHaveProperty("url");
		expect(fulfill.ctx.event.payload).toHaveProperty("method");

		// Correlation + parentEventId are tracked on the RuntimeEvents, not the
		// guest ctx. Pull fulfill/notify from the emitted stream.
		const validated = emitted.filter(
			(e) => e.type === "order.validated" && e.targetAction !== undefined,
		);
		expect(validated.length).toBeGreaterThanOrEqual(2);
		const corr = validated.at(0)?.correlationId;
		expect(corr).toMatch(CORR_PREFIX);
		for (const ev of validated) {
			expect(ev.correlationId).toBe(corr);
			expect(ev.parentEventId).toBeDefined();
		}
	});

	it("propagates headers and url through the full pipeline", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { ok: true } },
		});

		const workQueue = createWorkQueue();
		const bus = createEventBus([workQueue]);
		const source = createEventSource({ events: defaultSchemas }, bus);
		const createContext = createActionContext();

		const runCalls: RunCall[] = [];
		const sandboxFactory = async (actionSource: string): Promise<Sandbox> => ({
			run: async (name, ctx) => {
				runCalls.push({
					source: actionSource,
					name,
					ctx: ctx as RunCall["ctx"],
				});
				return { ok: true, result: undefined, logs: [] } satisfies RunResult;
			},
			dispose: () => {
				/* no-op */
			},
		});

		const actions: Action[] = [
			{
				name: "handleOrder",
				on: "webhook.order",
				env: {},
				source: "export default async (ctx) => { /* handleOrder */ }",
				exportName: "default",
			},
		];

		const scheduler = createScheduler(
			workQueue,
			source,
			{ actions },
			createContext,
			{ sandboxFactory },
		);
		scheduler.start();

		const app = createApp(
			httpTriggerMiddleware({ triggerRegistry: registry }, source),
		);

		await app.request("/webhooks/order?source=shopify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature": "sha256=test",
			},
			body: JSON.stringify({ orderId: "xyz" }),
		});

		await new Promise((r) => setTimeout(r, 100));
		await scheduler.stop();

		expect(runCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const ctx = runCalls[0]!.ctx;
		const payload = ctx.event.payload as {
			body: { orderId: string };
			headers: Record<string, string>;
			url: string;
			method: string;
		};

		expect(payload.body).toEqual({ orderId: "xyz" });
		expect(payload.headers["x-signature"]).toBe("sha256=test");
		expect(payload.url).toBe("http://localhost/webhooks/order?source=shopify");
		expect(payload.method).toBe("POST");
	});
});
