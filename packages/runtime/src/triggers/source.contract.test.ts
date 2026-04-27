import { describe, expect, it, vi } from "vitest";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	InvokeResult,
	ManualTriggerDescriptor,
} from "../executor/types.js";
import { createLogger } from "../logger.js";
import { createCronTriggerSource } from "./cron.js";
import { createHttpTriggerSource } from "./http.js";
import { createManualTriggerSource } from "./manual.js";
import type { TriggerEntry, TriggerSource } from "./source.js";
import { withZodSchemas } from "./test-descriptors.js";

// ---------------------------------------------------------------------------
// TriggerSource contract tests — parameterised by kind
// ---------------------------------------------------------------------------
//
// Every trigger kind's source must satisfy shared lifecycle invariants:
// start/stop are idempotent, reconfigure(owner, entries) replaces per-
// owner state atomically, empty entries clears a owner.

type Fire = (input: unknown) => Promise<InvokeResult<unknown>>;

interface KindFactory<K extends string> {
	readonly kind: K;
	readonly makeEntry: (name: string) => TriggerEntry;
	readonly createSource: () => TriggerSource;
}

const stubFire: Fire = () =>
	Promise.resolve({ ok: true, output: { status: 200 } });

const httpKind: KindFactory<"http"> = {
	kind: "http",
	makeEntry(name) {
		const descriptor: HttpTriggerDescriptor = withZodSchemas({
			kind: "http",
			type: "http",
			name,
			workflowName: "w",
			method: "POST",
			request: {
				body: { type: "object" },
				headers: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
		});
		return {
			descriptor,
			fire: vi.fn<Fire>(stubFire),
			exception: vi.fn(async () => undefined),
		};
	},
	createSource() {
		return createHttpTriggerSource() as unknown as TriggerSource;
	},
};

const cronKind: KindFactory<"cron"> = {
	kind: "cron",
	makeEntry(name) {
		const descriptor: CronTriggerDescriptor = withZodSchemas({
			kind: "cron",
			type: "cron",
			name,
			workflowName: "w",
			schedule: "0 0 1 1 *",
			tz: "UTC",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			outputSchema: {},
		});
		return {
			descriptor,
			fire: vi.fn<Fire>(stubFire),
			exception: vi.fn(async () => undefined),
		};
	},
	createSource() {
		return createCronTriggerSource({
			logger: createLogger("test-cron", { level: "silent" }),
		}) as unknown as TriggerSource;
	},
};

const manualKind: KindFactory<"manual"> = {
	kind: "manual",
	makeEntry(name) {
		const descriptor: ManualTriggerDescriptor = withZodSchemas({
			kind: "manual",
			type: "manual",
			name,
			workflowName: "w",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			outputSchema: {},
		});
		return {
			descriptor,
			fire: vi.fn<Fire>(stubFire),
			exception: vi.fn(async () => undefined),
		};
	},
	createSource() {
		return createManualTriggerSource() as unknown as TriggerSource;
	},
};

const KIND_FACTORIES: readonly KindFactory<string>[] = [
	httpKind,
	cronKind,
	manualKind,
];

for (const factory of KIND_FACTORIES) {
	describe(`TriggerSource contract: ${factory.kind}`, () => {
		it("exposes kind matching the factory's kind discriminator", () => {
			const source = factory.createSource();
			expect(source.kind).toBe(factory.kind);
		});

		it("start() is idempotent", async () => {
			const source = factory.createSource();
			await source.start();
			await source.start();
		});

		it("stop() is idempotent", async () => {
			const source = factory.createSource();
			await source.start();
			await source.stop();
			await source.stop();
		});

		it("reconfigure replaces per-owner state atomically", async () => {
			const source = factory.createSource();
			const resA = await source.reconfigure("t0", "r0", [
				factory.makeEntry("a"),
			]);
			expect(resA.ok).toBe(true);
			const resB = await source.reconfigure("t0", "r0", [
				factory.makeEntry("b"),
			]);
			expect(resB.ok).toBe(true);
			const resEmpty = await source.reconfigure("t0", "r0", []);
			expect(resEmpty.ok).toBe(true);
		});

		it("reconfigure with an empty entries array is a no-op on unknown owner", async () => {
			const source = factory.createSource();
			const res = await source.reconfigure("never-seen", "never-seen-repo", []);
			expect(res.ok).toBe(true);
		});
	});
}
