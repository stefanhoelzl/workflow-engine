// End-to-end tests for the sandboxPlugins() vite plugin (design §10).
//
// These tests instantiate the plugin, exercise resolveId/load against a
// temporary plugin file on disk, evaluate the emitted virtual-module
// output, and also execute the bundled worker source via data: URI import
// to verify the round-trip consumers rely on.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sandboxPlugins } from "./sandbox-plugins.js";

interface ViteLoadResult {
	code: string;
}

type LoadHandler = (id: string) => Promise<string | ViteLoadResult | undefined>;
type ResolveHandler = (
	source: string,
	importer: string | undefined,
) => string | undefined;

function getResolve(plugin: ReturnType<typeof sandboxPlugins>): ResolveHandler {
	const resolveId = plugin.resolveId;
	if (typeof resolveId !== "function") {
		throw new Error("sandboxPlugins did not expose resolveId");
	}
	return (src, imp) =>
		(resolveId as any).call(null, src, imp) as string | undefined;
}

function getLoad(plugin: ReturnType<typeof sandboxPlugins>): LoadHandler {
	const load = plugin.load;
	if (typeof load !== "function") {
		throw new Error("sandboxPlugins did not expose load");
	}
	return async (id) => (load as any).call(null, id);
}

async function importVirtualModule(code: string): Promise<unknown> {
	const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
	return await import(url);
}

describe("sandboxPlugins()", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sandbox-plugins-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("resolveId forwards non-matching specifiers", () => {
		const plugin = sandboxPlugins();
		const resolve = getResolve(plugin);
		expect(resolve("./foo", "/some/importer.ts")).toBeUndefined();
		expect(resolve("@scope/pkg", "/importer.ts")).toBeUndefined();
	});

	test("resolveId rewrites ?sandbox-plugin imports to a virtual id", () => {
		const plugin = sandboxPlugins();
		const resolve = getResolve(plugin);
		const importer = join(dir, "consumer.ts");
		const result = resolve("./plugin.ts?sandbox-plugin", importer);
		expect(result).toBeDefined();
		expect(result?.startsWith("\0sandbox-plugin:")).toBe(true);
		expect(result).toContain(join(dir, "plugin.ts"));
	});

	test("load emits { name, dependsOn, source } for a plugin file", async () => {
		// Author file: name + dependsOn + worker, plus a `prepare` helper using a
		// main-thread-only dep (simulated by a fat inline comment). Tree-shaking
		// should not include the prepare body in the bundled source.
		const pluginFile = join(dir, "example.ts");
		await writeFile(
			pluginFile,
			[
				'export const name = "example";',
				"export const dependsOn = [] as const;",
				"const MAIN_THREAD_ONLY_TOKEN = 'MAIN_THREAD_ONLY_TOKEN_9981';",
				"export function prepare() {",
				"  return { token: MAIN_THREAD_ONLY_TOKEN };",
				"}",
				"export function worker() {",
				'  return { note: "worker-side" };',
				"}",
				"",
			].join("\n"),
		);
		const plugin = sandboxPlugins();
		const resolve = getResolve(plugin);
		const load = getLoad(plugin);
		const importer = join(dir, "consumer.ts");
		const id = resolve(
			`${pathToFileURL(pluginFile).pathname}?sandbox-plugin`,
			importer,
		);
		expect(id).toBeDefined();
		if (!id) {
			throw new Error("unreachable");
		}
		const result = await load(id);
		const code = typeof result === "string" ? result : result?.code;
		expect(code).toBeDefined();
		if (!code) {
			throw new Error("unreachable");
		}
		// Virtual module output references the original file.
		expect(code).toContain(JSON.stringify(pluginFile));
		expect(code).toContain("export const name = mod.name;");
		expect(code).toContain("export const dependsOn = mod.dependsOn;");
		expect(code).toContain("export const source =");
		expect(code).toContain("export default { name, dependsOn, source };");
		// Tree-shaking check: the prepare function and its token must NOT
		// appear in the serialized `source` constant.
		const sourceMatch = code.match(/export const source = "([\s\S]*?)";/);
		expect(sourceMatch).not.toBeNull();
		if (!sourceMatch) {
			throw new Error("unreachable");
		}
		const bundledSource = JSON.parse(`"${sourceMatch[1]}"`) as string;
		expect(bundledSource).not.toContain("MAIN_THREAD_ONLY_TOKEN_9981");
		expect(bundledSource).not.toContain("prepare");
		expect(bundledSource).toContain("worker-side");
	});

	test("bundled source evaluates to a function returning the PluginSetup", async () => {
		const pluginFile = join(dir, "example.ts");
		await writeFile(
			pluginFile,
			[
				'export const name = "example";',
				"export function worker(ctx, deps, config) {",
				'  return { note: "worker-side", gotConfig: config };',
				"}",
				"",
			].join("\n"),
		);
		const plugin = sandboxPlugins();
		const resolve = getResolve(plugin);
		const load = getLoad(plugin);
		const id = resolve(
			`${pathToFileURL(pluginFile).pathname}?sandbox-plugin`,
			join(dir, "consumer.ts"),
		);
		if (!id) {
			throw new Error("unreachable");
		}
		const result = await load(id);
		const code = typeof result === "string" ? result : result?.code;
		if (!code) {
			throw new Error("unreachable");
		}
		const sourceMatch = code.match(/export const source = "([\s\S]*?)";/);
		if (!sourceMatch) {
			throw new Error("unreachable");
		}
		const bundledSource = JSON.parse(`"${sourceMatch[1]}"`) as string;
		const mod = (await importVirtualModule(bundledSource)) as {
			default: (ctx: unknown, deps: unknown, config: unknown) => unknown;
		};
		expect(typeof mod.default).toBe("function");
		const setup = mod.default(null, {}, { payload: 42 });
		expect(setup).toEqual({ note: "worker-side", gotConfig: { payload: 42 } });
	});

	test("plugin without dependsOn yields `undefined` through the namespace re-export", async () => {
		const pluginFile = join(dir, "example.ts");
		await writeFile(
			pluginFile,
			[
				'export const name = "no-deps";',
				"export function worker() { return {}; }",
				"",
			].join("\n"),
		);
		const plugin = sandboxPlugins();
		const resolve = getResolve(plugin);
		const load = getLoad(plugin);
		const id = resolve(
			`${pathToFileURL(pluginFile).pathname}?sandbox-plugin`,
			join(dir, "consumer.ts"),
		);
		if (!id) {
			throw new Error("unreachable");
		}
		const result = await load(id);
		const code = typeof result === "string" ? result : result?.code;
		if (!code) {
			throw new Error("unreachable");
		}
		// The namespace import protects us from a hard error; dependsOn is
		// simply `undefined` on the module namespace.
		expect(code).toContain("export const dependsOn = mod.dependsOn;");
	});
});
