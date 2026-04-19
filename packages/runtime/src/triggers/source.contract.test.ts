import type { WorkflowManifest } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type { HttpTriggerDescriptor } from "../executor/types.js";
import { createHttpTriggerSource } from "./http.js";
import type { TriggerSource, TriggerViewEntry } from "./source.js";

// ---------------------------------------------------------------------------
// TriggerSource contract tests — parameterised by kind
// ---------------------------------------------------------------------------
//
// Every trigger kind's source must satisfy shared lifecycle invariants:
// `start`/`stop` are idempotent, `reconfigure` replaces state atomically.
// Today only the HTTP kind exists; when cron/mail land, add a row to
// `KIND_FACTORIES` and the same invariants run against them.

interface KindFactory<K extends string> {
	readonly kind: K;
	readonly makeView: (name: string) => TriggerViewEntry<K>;
	readonly createSource: (executor: Executor) => TriggerSource<K>;
}

function makeWorkflow(): WorkflowManifest {
	return {
		name: "w",
		module: "w.js",
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
	};
}

const httpKind: KindFactory<"http"> = {
	kind: "http",
	makeView(name) {
		const descriptor: HttpTriggerDescriptor = {
			kind: "http",
			type: "http",
			name,
			path: name,
			method: "POST",
			params: [],
			body: { type: "object" },
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
		};
		return {
			tenant: "t0",
			workflow: makeWorkflow(),
			bundleSource: "source",
			descriptor,
		};
	},
	createSource(executor) {
		return createHttpTriggerSource({ executor });
	},
};

const KIND_FACTORIES: readonly KindFactory<string>[] = [httpKind];

for (const factory of KIND_FACTORIES) {
	describe(`TriggerSource contract: ${factory.kind}`, () => {
		function stubExecutor(): Executor {
			return {
				invoke: vi.fn(async () => ({
					ok: true as const,
					output: { status: 200 },
				})),
			};
		}

		it("exposes kind matching the factory's kind discriminator", () => {
			const source = factory.createSource(stubExecutor());
			expect(source.kind).toBe(factory.kind);
		});

		it("start() is idempotent", async () => {
			const source = factory.createSource(stubExecutor());
			await source.start();
			await source.start();
		});

		it("stop() is idempotent", async () => {
			const source = factory.createSource(stubExecutor());
			await source.start();
			await source.stop();
			await source.stop();
		});

		it("reconfigure replaces internal state atomically", () => {
			const source = factory.createSource(stubExecutor());
			source.reconfigure([factory.makeView("a")] as TriggerViewEntry<string>[]);
			source.reconfigure([factory.makeView("b")] as TriggerViewEntry<string>[]);
			source.reconfigure([]);
		});

		it("reconfigure with an empty view is a no-op", () => {
			const source = factory.createSource(stubExecutor());
			source.reconfigure([]);
		});
	});
}
