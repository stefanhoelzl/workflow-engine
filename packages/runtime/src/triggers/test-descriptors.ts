import type { z } from "@workflow-engine/core";
import { vi } from "vitest";
import type {
	BaseTriggerDescriptor,
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	ImapTriggerDescriptor,
	InvokeResult,
	ManualTriggerDescriptor,
	TriggerDescriptor,
	WsTriggerDescriptor,
} from "../executor/types.js";
import { rehydrateSchemaForTests } from "../workflow-registry.js";
import type { TriggerEntry } from "./source.js";

// Test-only helper. Augments a hand-crafted (sentinel-resolved) descriptor
// stub with the pre-rehydrated Zod schemas the production registry attaches
// at registration time. Test files that build descriptors inline pipe them
// through this helper so they satisfy `TriggerDescriptor`'s type contract
// without each test re-implementing rehydration. Uses the same
// `strip`-marker-aware rehydration the production registry uses, so test
// fixtures with `strip: true` markers behave identically to production.
function withZodSchemas<
	D extends Omit<TriggerDescriptor, "zodInputSchema" | "zodOutputSchema">,
>(
	descriptor: D,
): D & {
	zodInputSchema: z.ZodType<unknown>;
	zodOutputSchema: z.ZodType<unknown>;
} {
	return {
		...descriptor,
		zodInputSchema: rehydrateSchemaForTests(descriptor.inputSchema),
		zodOutputSchema: rehydrateSchemaForTests(descriptor.outputSchema),
	};
}

const EMPTY_OBJECT_SCHEMA = { type: "object" } as const;
const EMPTY_HEADERS_SCHEMA = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

function makeHttpDescriptor(
	overrides: Partial<HttpTriggerDescriptor> = {},
): HttpTriggerDescriptor {
	return withZodSchemas({
		kind: "http",
		type: "http",
		name: "t",
		workflowName: "w",
		method: "POST",
		request: { body: EMPTY_OBJECT_SCHEMA, headers: EMPTY_HEADERS_SCHEMA },
		inputSchema: EMPTY_OBJECT_SCHEMA,
		outputSchema: EMPTY_OBJECT_SCHEMA,
		...overrides,
	});
}

function makeCronDescriptor(
	overrides: Partial<CronTriggerDescriptor> = {},
): CronTriggerDescriptor {
	return withZodSchemas({
		kind: "cron",
		type: "cron",
		name: "t",
		workflowName: "w",
		schedule: "* * * * *",
		tz: "UTC",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
		...overrides,
	});
}

function makeManualDescriptor(
	overrides: Partial<ManualTriggerDescriptor> = {},
): ManualTriggerDescriptor {
	return withZodSchemas({
		kind: "manual",
		type: "manual",
		name: "t",
		workflowName: "w",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
		...overrides,
	});
}

function makeImapDescriptor(
	overrides: Partial<ImapTriggerDescriptor> & { port: number },
): ImapTriggerDescriptor {
	const { port, ...rest } = overrides;
	return withZodSchemas({
		kind: "imap",
		type: "imap",
		name: "inbound",
		workflowName: "w",
		host: "127.0.0.1",
		tls: "none",
		insecureSkipVerify: false,
		user: "dev",
		password: "devpass",
		folder: "INBOX",
		search: "ALL",
		mode: "poll",
		onError: {},
		inputSchema: {} as Record<string, unknown>,
		outputSchema: {} as Record<string, unknown>,
		...rest,
		port,
	});
}

function makeWsDescriptor(
	overrides: Partial<WsTriggerDescriptor> = {},
): WsTriggerDescriptor {
	return withZodSchemas({
		kind: "ws",
		type: "ws",
		name: "echo",
		workflowName: "wf",
		request: {
			type: "object",
			properties: { greet: { type: "string" } },
			required: ["greet"],
			additionalProperties: false,
		},
		response: {},
		inputSchema: {
			type: "object",
			properties: {
				data: {
					type: "object",
					properties: { greet: { type: "string" } },
					required: ["greet"],
					additionalProperties: false,
				},
			},
			required: ["data"],
			additionalProperties: false,
		},
		outputSchema: {},
		...overrides,
	});
}

type Fire<D extends BaseTriggerDescriptor<string>> = TriggerEntry<D>["fire"];

interface MockTriggerEntry<D extends BaseTriggerDescriptor<string>>
	extends TriggerEntry<D> {
	readonly fire: ReturnType<typeof vi.fn> & Fire<D>;
	readonly exception: ReturnType<typeof vi.fn> & TriggerEntry<D>["exception"];
}

// Builds a `TriggerEntry` whose `fire` and `exception` are `vi.fn()`s.
// Defaults to a `fire` that resolves `{ ok: true, output: undefined }`.
// Pass `onFire` to customise the dispatch shape (e.g. running the real
// validator inside the closure).
function makeTriggerEntry<D extends BaseTriggerDescriptor<string>>(
	descriptor: D,
	opts: {
		onFire?: Fire<D>;
		onException?: TriggerEntry<D>["exception"];
	} = {},
): MockTriggerEntry<D> {
	const fire = vi.fn<Fire<D>>(
		opts.onFire ??
			(async () => ({ ok: true, output: undefined }) as InvokeResult<unknown>),
	);
	const exception = vi.fn<TriggerEntry<D>["exception"]>(
		opts.onException ?? (async () => undefined),
	);
	return { descriptor, fire, exception } as MockTriggerEntry<D>;
}

export type { MockTriggerEntry };
export {
	makeCronDescriptor,
	makeHttpDescriptor,
	makeImapDescriptor,
	makeManualDescriptor,
	makeTriggerEntry,
	makeWsDescriptor,
	withZodSchemas,
};
