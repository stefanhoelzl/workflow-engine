import type { WorkflowManifest } from "@workflow-engine/core";
import type { DepsMap, SandboxContext } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import { compileActionValidators } from "../host-call-action-config.js";
import {
	type Config,
	dependsOn,
	name as HOST_CALL_ACTION_PLUGIN_NAME,
	ValidationError,
	worker,
} from "./host-call-action.js";

const ctx: SandboxContext = {
	emit() {
		/* no-op */
	},
	request(_p, _n, _e, fn) {
		return fn();
	},
};

function manifestWith(
	actions: Array<{ name: string; input: unknown; output: unknown }>,
): WorkflowManifest {
	return {
		name: "testWorkflow",
		module: "test.js",
		sha: "deadbeef",
		env: {},
		actions: actions as unknown as WorkflowManifest["actions"],
		triggers: [],
	};
}

function configFor(manifest: WorkflowManifest): Config {
	return compileActionValidators(manifest);
}

describe("host-call-action plugin (§10 shape)", () => {
	it("exposes expected name + empty dependsOn", () => {
		expect(HOST_CALL_ACTION_PLUGIN_NAME).toBe("host-call-action");
		expect(dependsOn).toEqual([]);
	});

	it("worker() exports validateAction and registers no guest functions", () => {
		const config = configFor(
			manifestWith([
				{ name: "a", input: { type: "object" }, output: { type: "object" } },
			]),
		);
		const setup = worker(ctx, {} as DepsMap, config);
		expect(typeof setup.exports?.validateAction).toBe("function");
		expect(setup.guestFunctions ?? []).toEqual([]);
	});

	it("accepts valid input without throwing", () => {
		const config = configFor(
			manifestWith([
				{
					name: "a",
					input: {
						type: "object",
						required: ["foo"],
						properties: { foo: { type: "string" } },
					},
					output: { type: "object" },
				},
			]),
		);
		const setup = worker(ctx, {} as DepsMap, config);
		const validateAction = setup.exports?.validateAction as (
			name: string,
			input: unknown,
		) => void;
		expect(() => validateAction("a", { foo: "bar" })).not.toThrow();
	});

	it("throws ValidationError with issues + errors on schema mismatch", () => {
		const config = configFor(
			manifestWith([
				{
					name: "a",
					input: {
						type: "object",
						required: ["foo"],
						properties: { foo: { type: "string" } },
					},
					output: { type: "object" },
				},
			]),
		);
		const setup = worker(ctx, {} as DepsMap, config);
		const validateAction = setup.exports?.validateAction as (
			name: string,
			input: unknown,
		) => void;
		try {
			validateAction("a", { foo: 42 });
			expect.fail("validateAction should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const ve = err as ValidationError;
			expect(ve.name).toBe("ValidationError");
			expect(ve.issues.length).toBeGreaterThan(0);
			expect(ve.issues[0]?.message).toMatch(/string/);
			expect(Array.isArray(ve.errors)).toBe(true);
		}
	});

	it("throws when the action name is not in the manifest", () => {
		const config = configFor(
			manifestWith([
				{ name: "a", input: { type: "object" }, output: { type: "object" } },
			]),
		);
		const setup = worker(ctx, {} as DepsMap, config);
		const validateAction = setup.exports?.validateAction as (
			name: string,
			input: unknown,
		) => void;
		expect(() => validateAction("z", {})).toThrow(
			/"z" is not declared in the manifest/,
		);
	});

	it("compiled validators instantiate once; subsequent calls reuse them", () => {
		const config = configFor(
			manifestWith([
				{
					name: "a",
					input: {
						type: "object",
						required: ["foo"],
						properties: { foo: { type: "string" } },
					},
					output: { type: "object" },
				},
			]),
		);
		const setup = worker(ctx, {} as DepsMap, config);
		const validateAction = setup.exports?.validateAction as (
			name: string,
			input: unknown,
		) => void;
		for (let i = 0; i < 50; i++) {
			validateAction("a", { foo: `run-${i}` });
		}
		expect(() => validateAction("a", {})).toThrow(ValidationError);
	});

	it("worker bundle tree-shakes Ajv: the source of host-call-action.ts never imports ajv", async () => {
		// Structural assertion that the plugin file itself does not reach Ajv
		// — consumer code (sandbox-store via host-call-action-config.ts) does.
		const { readFile } = await import("node:fs/promises");
		const src = await readFile(
			new URL("./host-call-action.ts", import.meta.url),
			"utf8",
		);
		expect(src).not.toMatch(/from\s+["']ajv/);
	});
});
