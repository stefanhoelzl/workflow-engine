import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoverWorkflows,
	typecheckWorkflows,
	workflowPlugin,
} from "./index.js";

const NO_WORKFLOWS_FOUND = /no workflows found/;

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wf-test-"));
	await writeFile(join(dir, "package.json"), '{"type":"module"}');
	return dir;
}

async function createSrc(dir: string): Promise<string> {
	const srcDir = join(dir, "src");
	await mkdir(srcDir);
	return srcDir;
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

describe("discoverWorkflows", () => {
	it("discovers a single .ts file in src/", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(join(srcDir, "foo.ts"), "");

		await expect(discoverWorkflows(dir)).resolves.toEqual(["foo.ts"]);
	});

	it("discovers multiple .ts files sorted", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(join(srcDir, "bar.ts"), "");
		await writeFile(join(srcDir, "foo.ts"), "");

		await expect(discoverWorkflows(dir)).resolves.toEqual(["bar.ts", "foo.ts"]);
	});

	it("ignores nested directories", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(join(srcDir, "foo.ts"), "");
		await mkdir(join(srcDir, "shared"));
		await writeFile(join(srcDir, "shared", "util.ts"), "");

		await expect(discoverWorkflows(dir)).resolves.toEqual(["foo.ts"]);
	});

	it("ignores non-.ts files", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(join(srcDir, "foo.ts"), "");
		await writeFile(join(srcDir, "readme.md"), "");
		await writeFile(join(srcDir, "types.d.ts"), "");

		const result = await discoverWorkflows(dir);
		expect(result).toContain("foo.ts");
		expect(result).toContain("types.d.ts");
		expect(result).not.toContain("readme.md");
	});

	it("errors loudly when src/ does not exist", async () => {
		const dir = await createTempDir();
		await expect(discoverWorkflows(dir)).rejects.toThrow(NO_WORKFLOWS_FOUND);
	});

	it("errors loudly when src/ is empty", async () => {
		const dir = await createTempDir();
		await createSrc(dir);
		await expect(discoverWorkflows(dir)).rejects.toThrow(NO_WORKFLOWS_FOUND);
	});
});

// biome-ignore lint/suspicious/noExplicitAny: testing plugin hooks directly
type PluginHooks = Record<string, (...args: any[]) => unknown>;

describe("workflowPlugin buildStart", () => {
	it("skips type checking in watch mode", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(
			join(srcDir, "ok.ts"),
			"const x: number = 42;\nexport default x;\n",
		);

		const plugin = workflowPlugin();
		const hooks = plugin as unknown as PluginHooks;

		await hooks.config({ root: dir });
		hooks.configResolved({ build: { watch: {} }, root: dir });

		expect(() => hooks.buildStart()).not.toThrow();
	});

	it("runs type checking in non-watch mode", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(
			join(srcDir, "ok.ts"),
			"const x: number = 42;\nexport default x;\n",
		);

		const plugin = workflowPlugin();
		const hooks = plugin as unknown as PluginHooks;

		await hooks.config({ root: dir });
		hooks.configResolved({ build: {}, root: dir });

		expect(() => hooks.buildStart()).not.toThrow();
	});
});

describe("workflowPlugin config", () => {
	it("returns build entry map derived from src/", async () => {
		const dir = await createTempDir();
		const srcDir = await createSrc(dir);
		await writeFile(join(srcDir, "foo.ts"), "");
		await writeFile(join(srcDir, "bar.ts"), "");

		const plugin = workflowPlugin();
		const hooks = plugin as unknown as PluginHooks;

		const result = (await hooks.config({ root: dir })) as {
			build: { lib: { entry: Record<string, string> } };
		};

		expect(Object.keys(result.build.lib.entry).sort()).toEqual(["bar", "foo"]);
		expect(result.build.lib.entry.foo).toBe("./src/foo.ts");
	});

	it("throws when src/ is missing", async () => {
		const dir = await createTempDir();
		const plugin = workflowPlugin();
		const hooks = plugin as unknown as PluginHooks;

		await expect(hooks.config({ root: dir })).rejects.toThrow(
			NO_WORKFLOWS_FOUND,
		);
	});
});
