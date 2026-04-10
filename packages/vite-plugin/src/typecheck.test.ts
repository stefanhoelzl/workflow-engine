import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { typecheckWorkflows } from "./index.js";

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wf-test-"));
	await writeFile(join(dir, "package.json"), '{"type":"module"}');
	return dir;
}

describe("typecheckWorkflows", () => {
	it("throws on type errors", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "bad.ts"),
			`const x: number = "not a number";\nexport default x;\n`,
		);

		expect(() => typecheckWorkflows(["./bad.ts"], dir)).toThrow(
			"TypeScript errors in workflows",
		);
	});

	it("succeeds with valid TypeScript", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "good.ts"),
			"const x: number = 42;\nexport default x;\n",
		);

		expect(() => typecheckWorkflows(["./good.ts"], dir)).not.toThrow();
	});
});

describe("workflowPlugin buildStart", () => {
	it("skips type checking in watch mode", async () => {
		const { workflowPlugin } = await import("./index.js");
		const plugin = workflowPlugin({ workflows: ["./nonexistent.ts"] });

		// biome-ignore lint/suspicious/noExplicitAny: testing plugin hooks directly
		const hooks = plugin as Record<string, (...args: any[]) => unknown>;

		hooks.configResolved({ build: { watch: {} }, root: "/tmp" });

		// buildStart should not throw even with a nonexistent file
		// because watch mode skips type checking entirely
		expect(() => hooks.buildStart()).not.toThrow();
	});
});
