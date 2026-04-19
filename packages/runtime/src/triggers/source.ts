import type { WorkflowManifest } from "@workflow-engine/core";
import type { BaseTriggerDescriptor } from "../executor/types.js";

// ---------------------------------------------------------------------------
// TriggerSource — the per-kind protocol adapter contract.
// ---------------------------------------------------------------------------
//
// Every trigger kind (http, future: cron, mail, ...) ships a TriggerSource
// implementation. The runtime (main.ts) constructs one source per kind with
// shared deps, passes the list into the WorkflowRegistry (the plugin host),
// and manages start()/stop() lifecycle. On every workflow state change, the
// registry synchronously calls source.reconfigure(kindView) with the
// pre-filtered list of descriptors for that kind.

interface TriggerViewEntry<K extends string = string> {
	readonly tenant: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly descriptor: BaseTriggerDescriptor<K>;
}

interface TriggerSource<K extends string = string> {
	readonly kind: K;
	start(): Promise<void>;
	stop(): Promise<void>;
	reconfigure(view: readonly TriggerViewEntry<K>[]): void;
}

export type { TriggerSource, TriggerViewEntry };
