import type { Manifest, WorkflowManifest } from "@workflow-engine/core";

type WorkflowAction = WorkflowManifest["actions"][number];

const DEFAULT_SHA = "0".repeat(64);

function makeWorkflowManifest(
	overrides: Partial<WorkflowManifest> = {},
): WorkflowManifest {
	return {
		name: "wf",
		module: "wf.js",
		sha: DEFAULT_SHA,
		env: {},
		actions: [],
		triggers: [],
		...overrides,
	};
}

function makeWorkflowAction(
	overrides: Partial<WorkflowAction> = {},
): WorkflowAction {
	return {
		name: "doIt",
		input: { type: "object" },
		output: { type: "object" },
		...overrides,
	};
}

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		workflows: [],
		...overrides,
	};
}

export type { WorkflowAction };
export { makeManifest, makeWorkflowAction, makeWorkflowManifest };
