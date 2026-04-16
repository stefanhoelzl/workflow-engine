import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { describe, expect, it } from "vitest";
import { workflowPlugin } from "./index.js";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..", "..", "..", "..");

const ERR_AT_MOST_ONE_DEFINE = /at most one defineWorkflow/;
const ERR_ACTION_MULTI_NAME = /exported under multiple names/;
const ERR_MISSING_HANDLER = /missing a handler function/;
const ERR_NOT_ZOD_SCHEMA = /is not a Zod schema/;
const EXPORT_ON_EVENT_RE = /export\s*\{[^}]*onEvent/;
const EXPORT_SEND_NOTIFICATION_RE = /export\s*\{[^}]*sendNotification/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// The fixtures below import `@workflow-engine/sdk` by name. For Vite to
// resolve that from a temp workspace, we symlink the repo's SDK into the temp
// `node_modules` tree. The plugin itself is imported directly from src; the
// SDK is what the fixtures import.
async function linkSdk(tempDir: string): Promise<void> {
	const { symlink } = await import("node:fs/promises");
	const nm = join(tempDir, "node_modules");
	const scoped = join(nm, "@workflow-engine");
	await mkdir(scoped, { recursive: true });
	const target = resolve(repoRoot, "packages", "sdk");
	await symlink(target, join(scoped, "sdk"), "dir");
}

interface BuildFixtureArgs {
	files: Record<string, string>;
	workflows: string[];
}

async function buildFixture(args: BuildFixtureArgs): Promise<{
	outDir: string;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "wf-build-"));
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify({ type: "module" }, null, 2),
	);
	await linkSdk(dir);
	await Promise.all(
		Object.entries(args.files).map(async ([relative, content]) => {
			const full = join(dir, relative);
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, content, "utf8");
		}),
	);

	await viteBuild({
		configFile: false,
		root: dir,
		logLevel: "silent",
		plugins: [
			skipTypecheckPlugin(),
			workflowPlugin({ workflows: args.workflows }),
		],
	});
	return { outDir: join(dir, "dist"), dir };
}

// Stub plugin that fakes `watch` into resolvedConfig so the workflow-engine
// plugin's buildStart skips the typechecker. Fixture workflows are not part
// of a full tsconfig and would produce noisy lib-resolution errors otherwise.
function skipTypecheckPlugin() {
	return {
		name: "test:skip-typecheck",
		enforce: "pre" as const,
		configResolved(config: { build: { watch: unknown } }) {
			Object.defineProperty(config.build, "watch", {
				value: {},
				configurable: true,
				writable: true,
				enumerable: true,
			});
		},
	};
}

async function readManifest(outDir: string, name: string): Promise<unknown> {
	const content = await readFile(join(outDir, name, "manifest.json"), "utf8");
	return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASIC_WORKFLOW = `
import { action, defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const sendNotification = action({
	input: z.object({ message: z.string() }),
	output: z.object({ ok: z.boolean() }),
	handler: async ({ message }) => ({ ok: message.length > 0 }),
});

export const onEvent = httpTrigger({
	path: "cronitor",
	body: z.object({ id: z.string() }),
	handler: async ({ body }) => {
		const result = await sendNotification({ message: body.id });
		return { status: 202, body: result };
	},
});
`;

const NAMED_WORKFLOW = `
import { defineWorkflow } from "@workflow-engine/sdk";

export const workflow = defineWorkflow({ name: "custom-name" });
`;

const NO_DEFINE_WORKFLOW = `
import { action, z } from "@workflow-engine/sdk";

export const anAction = action({
	input: z.object({}),
	output: z.string(),
	handler: async () => "x",
});
`;

const TWO_DEFINE_WORKFLOWS = `
import { defineWorkflow } from "@workflow-engine/sdk";

export const a = defineWorkflow({ name: "a" });
export const b = defineWorkflow({ name: "b" });
`;

const ACTION_TWO_NAMES = `
import { action, defineWorkflow, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

const inner = action({
	input: z.object({}),
	output: z.string(),
	handler: async () => "x",
});

export { inner };
export { inner as alias };
`;

const TRIGGER_WITH_QUERY = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const search = httpTrigger({
	path: "search/:id",
	method: "GET",
	query: z.object({ q: z.string() }),
	handler: async () => ({ status: 200 }),
});
`;

const WILDCARD_TRIGGER = `
import { defineWorkflow, httpTrigger } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const file = httpTrigger({
	path: "files/*rest",
	handler: async () => ({}),
});
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflowPlugin: brand-based discovery", () => {
	it("emits per-workflow bundle and manifest with actions and triggers", async () => {
		const { outDir } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		const manifest = (await readManifest(outDir, "basic")) as {
			name: string;
			module: string;
			sha: string;
			env: Record<string, string>;
			actions: Array<{ name: string; input: unknown; output: unknown }>;
			triggers: Array<{
				name: string;
				type: string;
				path: string;
				method: string;
				body: unknown;
				params: string[];
				query?: unknown;
			}>;
		};
		expect(manifest.name).toBe("basic");
		expect(manifest.module).toBe("basic.js");
		// sha is a 64-char hex SHA-256 of the bundle source.
		expect(manifest.sha).toMatch(SHA256_HEX_RE);
		expect(manifest.env).toEqual({});
		expect(manifest.actions).toHaveLength(1);
		expect(manifest.actions[0]?.name).toBe("sendNotification");
		expect(manifest.triggers).toHaveLength(1);
		expect(manifest.triggers[0]?.name).toBe("onEvent");
		expect(manifest.triggers[0]?.type).toBe("http");
		expect(manifest.triggers[0]?.method).toBe("POST");
		expect(manifest.triggers[0]?.path).toBe("cronitor");
		// No query supplied → field omitted from manifest entry.
		expect(manifest.triggers[0]?.query).toBeUndefined();

		const bundlePath = join(outDir, "basic", "basic.js");
		const bundleSrc = await readFile(bundlePath, "utf8");
		// Bundle is an ES module with the original named exports preserved.
		expect(bundleSrc).toMatch(EXPORT_ON_EVENT_RE);
		expect(bundleSrc).toMatch(EXPORT_SEND_NOTIFICATION_RE);

		// sha matches SHA-256 of the bundle source bytes — verify by recomputing.
		const { createHash } = await import("node:crypto");
		const expectedSha = createHash("sha256").update(bundleSrc).digest("hex");
		expect(manifest.sha).toBe(expectedSha);
	});

	it("generates JSON Schema for input, output, and trigger body", async () => {
		const { outDir } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		const manifest = (await readManifest(outDir, "basic")) as {
			actions: Array<{
				input: Record<string, unknown>;
				output: Record<string, unknown>;
			}>;
			triggers: Array<{ body: Record<string, unknown> }>;
		};
		const inputSchema = manifest.actions[0]?.input as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(inputSchema.type).toBe("object");
		expect(inputSchema.properties).toHaveProperty("message");
		expect(inputSchema.required).toContain("message");

		const outputSchema = manifest.actions[0]?.output as {
			type: string;
			properties: Record<string, unknown>;
		};
		expect(outputSchema.type).toBe("object");
		expect(outputSchema.properties).toHaveProperty("ok");

		const bodySchema = manifest.triggers[0]?.body as {
			type: string;
			properties: Record<string, unknown>;
		};
		expect(bodySchema.type).toBe("object");
		expect(bodySchema.properties).toHaveProperty("id");
	});
});

describe("workflowPlugin: name derivation", () => {
	it("defaults workflow name to the file's filestem", async () => {
		const { outDir } = await buildFixture({
			files: { "no_define.ts": NO_DEFINE_WORKFLOW },
			workflows: ["./no_define.ts"],
		});
		const manifest = (await readManifest(outDir, "no_define")) as {
			name: string;
			module: string;
			env: Record<string, string>;
		};
		expect(manifest.name).toBe("no_define");
		expect(manifest.module).toBe("no_define.js");
		expect(manifest.env).toEqual({});
	});

	it("uses explicit defineWorkflow({name}) when provided", async () => {
		const { outDir } = await buildFixture({
			files: { "wf.ts": NAMED_WORKFLOW },
			workflows: ["./wf.ts"],
		});
		const manifest = (await readManifest(outDir, "custom-name")) as {
			name: string;
			module: string;
		};
		expect(manifest.name).toBe("custom-name");
		expect(manifest.module).toBe("custom-name.js");
	});
});

describe("workflowPlugin: HTTP trigger entry", () => {
	it("emits query schema + params when supplied", async () => {
		const { outDir } = await buildFixture({
			files: { "q.ts": TRIGGER_WITH_QUERY },
			workflows: ["./q.ts"],
		});
		const manifest = (await readManifest(outDir, "q")) as {
			triggers: Array<{
				name: string;
				method: string;
				path: string;
				params: string[];
				query?: Record<string, unknown>;
			}>;
		};
		const t = manifest.triggers[0];
		expect(t?.method).toBe("GET");
		expect(t?.path).toBe("search/:id");
		expect(t?.params).toEqual(["id"]);
		expect(t?.query).toBeDefined();
	});

	it("extracts wildcard params from the trigger path", async () => {
		const { outDir } = await buildFixture({
			files: { "w.ts": WILDCARD_TRIGGER },
			workflows: ["./w.ts"],
		});
		const manifest = (await readManifest(outDir, "w")) as {
			triggers: Array<{ params: string[] }>;
		};
		expect(manifest.triggers[0]?.params).toEqual(["rest"]);
	});
});

describe("workflowPlugin: build failures", () => {
	it("fails when more than one defineWorkflow is exported", async () => {
		await expect(
			buildFixture({
				files: { "two.ts": TWO_DEFINE_WORKFLOWS },
				workflows: ["./two.ts"],
			}),
		).rejects.toThrow(ERR_AT_MOST_ONE_DEFINE);
	});

	it("fails when the same action is exported under two names", async () => {
		await expect(
			buildFixture({
				files: { "dup.ts": ACTION_TWO_NAMES },
				workflows: ["./dup.ts"],
			}),
		).rejects.toThrow(ERR_ACTION_MULTI_NAME);
	});

	it("fails when a trigger has no handler function", async () => {
		const badTrigger = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

// Bypass the SDK's type check to simulate a mis-constructed trigger reaching
// the plugin. The plugin guards against this even though the SDK's types
// require handler.
// biome-ignore lint/suspicious/noExplicitAny: test fixture
export const broken = httpTrigger({ path: "x" } as any);
`;
		await expect(
			buildFixture({
				files: { "nohandler.ts": badTrigger },
				workflows: ["./nohandler.ts"],
			}),
		).rejects.toThrow(ERR_MISSING_HANDLER);
	});

	it("fails when an action's input is not a Zod schema", async () => {
		const badAction = `
import { action, defineWorkflow } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

// Intentionally passing a non-Zod value as the schema.
export const bad = action({
	// biome-ignore lint/suspicious/noExplicitAny: test fixture
	input: { not: "a zod schema" } as any,
	// biome-ignore lint/suspicious/noExplicitAny: test fixture
	output: { not: "a zod schema" } as any,
	handler: async () => "x",
});
`;
		await expect(
			buildFixture({
				files: { "bad.ts": badAction },
				workflows: ["./bad.ts"],
			}),
		).rejects.toThrow(ERR_NOT_ZOD_SCHEMA);
	});
});
