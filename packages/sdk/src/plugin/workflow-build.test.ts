import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { extract as tarExtract } from "tar-stream";
import { build as viteBuild } from "vite";
import { describe, expect, it } from "vitest";
import { workflowPlugin } from "./index.js";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..", "..", "..", "..");

const ERR_AT_MOST_ONE_DEFINE = /at most one defineWorkflow/;
const ERR_ACTION_MULTI_NAME = /exported under multiple names/;
const ERR_MISSING_HANDLER = /missing a handler function/;
const ERR_NOT_ZOD_SCHEMA = /is not a Zod schema/;
const ERR_ACTION_NOT_TRANSFORMED =
	/was not transformed at build time. Actions must be declared as/;
const ERR_ACTION_DEFAULT_EXPORT =
	/action cannot be a default export; use .export const./;
// The IIFE bundle assigns its exports as properties on the namespace object,
// so the bundle source contains lines like `exports.onEvent = ...` / `exports.sendNotification = ...`.
const EXPORT_ON_EVENT_RE = /exports\.onEvent\s*=/;
const EXPORT_SEND_NOTIFICATION_RE = /exports\.sendNotification\s*=/;
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

async function readTenantBundle(outDir: string): Promise<Map<string, string>> {
	const bundleBytes = await readFile(join(outDir, "bundle.tar.gz"));
	const files = new Map<string, string>();
	const extractor = tarExtract();
	extractor.on("entry", (header, stream, next) => {
		if (header.type === "file") {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => {
				files.set(header.name, Buffer.concat(chunks).toString("utf-8"));
				next();
			});
		} else {
			stream.on("end", () => next());
			stream.resume();
		}
	});
	await pipeline(Readable.from(bundleBytes), createGunzip(), extractor);
	return files;
}

async function readWorkflowManifest(
	outDir: string,
	name: string,
): Promise<unknown> {
	const files = await readTenantBundle(outDir);
	const manifestRaw = files.get("manifest.json");
	if (!manifestRaw) {
		throw new Error(`manifest.json missing from bundle.tar.gz at ${outDir}`);
	}
	const tenant = JSON.parse(manifestRaw) as {
		workflows: Array<{ name: string }>;
	};
	const wf = tenant.workflows.find((w) => w.name === name);
	if (!wf) {
		throw new Error(`workflow "${name}" not in tenant manifest`);
	}
	return wf;
}

async function readWorkflowBundleSource(
	outDir: string,
	name: string,
): Promise<string> {
	const files = await readTenantBundle(outDir);
	const src = files.get(`${name}.js`);
	if (!src) {
		throw new Error(`${name}.js missing from tenant bundle`);
	}
	return src;
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

// Alias-only: `inner` IS declared via `export const` (so the AST transform
// injects `name: "inner"`), but `alias` exports the same callable under a
// second name. The plugin's identity-set check catches this at build time.
const ACTION_TWO_NAMES = `
import { action, defineWorkflow, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const inner = action({
	input: z.object({}),
	output: z.string(),
	handler: async () => "x",
});

export { inner as alias };
`;

// Detached export: the variable is declared with `const` (not `export const`)
// and then exported via a named-export specifier. The AST transform only
// matches `export const X = action({...})` declarations, so `inner` here is
// not transformed; the post-bundle "every action has a name" check catches it.
const ACTION_DETACHED_EXPORT = `
import { action, defineWorkflow, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

const inner = action({
	input: z.object({}),
	output: z.string(),
	handler: async () => "x",
});

export { inner };
`;

const ACTION_DEFAULT_EXPORT = `
import { action, defineWorkflow, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export default action({
	input: z.object({}),
	output: z.string(),
	handler: async () => "x",
});
`;

// Factory wrapper: the action() call is hidden inside a helper, so the AST
// transform cannot see it. Runtime detection kicks in via the "every action
// has a name" check.
const ACTION_FACTORY_WRAPPER = `
import { action, defineWorkflow, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

function makeAction() {
	return action({
		input: z.object({}),
		output: z.string(),
		handler: async () => "x",
	});
}

export const wrapped = makeAction();
`;

const TRIGGER_NON_URL_SAFE_NAME = `
import { defineWorkflow, httpTrigger } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const $weird = httpTrigger({
	handler: async () => ({}),
});
`;

const TRIGGER_UNDERSCORE_PREFIX_NAME = `
import { defineWorkflow, httpTrigger } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const _privateHook = httpTrigger({
	handler: async () => ({}),
});
`;

const CRON_WORKFLOW_EXPLICIT_TZ = `
import { cronTrigger, defineWorkflow } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const daily = cronTrigger({
	schedule: "0 9 * * *",
	tz: "Europe/Berlin",
	handler: async () => {},
});
`;

const CRON_WORKFLOW_DEFAULT_TZ = `
import { cronTrigger, defineWorkflow } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const heartbeat = cronTrigger({
	schedule: "*/5 * * * *",
	handler: async () => {},
});
`;

const CRON_AND_HTTP_WORKFLOW = `
import { cronTrigger, defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const ping = httpTrigger({
	body: z.object({}),
	handler: async () => ({}),
});

export const nightly = cronTrigger({
	schedule: "0 2 * * *",
	tz: "UTC",
	handler: async () => {},
});
`;

const MANUAL_WORKFLOW_DEFAULT_SCHEMAS = `
import { defineWorkflow, manualTrigger } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const rerun = manualTrigger({
	handler: async () => "done",
});
`;

const MANUAL_WORKFLOW_AUTHOR_SCHEMAS = `
import { defineWorkflow, manualTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const reprocessOrder = manualTrigger({
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.boolean() }),
	handler: async ({ id }) => ({ ok: id !== "" }),
});
`;

const MANUAL_WORKFLOW_INVALID_NAME = `
import { defineWorkflow, manualTrigger } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

const inner = manualTrigger({ handler: async () => {} });
export { inner as $weird };
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
		const manifest = (await readWorkflowManifest(outDir, "basic")) as {
			name: string;
			module: string;
			sha: string;
			env: Record<string, string>;
			actions: Array<{ name: string; input: unknown; output: unknown }>;
			triggers: Array<{
				name: string;
				type: string;
				method: string;
				body: unknown;
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
		// No path, params, or query fields on HTTP trigger manifest entries.
		expect(
			(manifest.triggers[0] as Record<string, unknown>).path,
		).toBeUndefined();
		expect(
			(manifest.triggers[0] as Record<string, unknown>).params,
		).toBeUndefined();
		expect(
			(manifest.triggers[0] as Record<string, unknown>).query,
		).toBeUndefined();

		const bundleSrc = await readWorkflowBundleSource(outDir, "basic");
		// Bundle is an ES module with the original named exports preserved.
		expect(bundleSrc).toMatch(EXPORT_ON_EVENT_RE);
		// The AST transform injects `name: "sendNotification"` into the
		// `action({...})` call at build time. Confirm the literal appears
		// in the emitted bundle source.
		expect(bundleSrc).toContain('name: "sendNotification"');
		expect(bundleSrc).toMatch(EXPORT_SEND_NOTIFICATION_RE);

		// sha matches SHA-256 of the bundle source bytes — verify by recomputing.
		const { createHash } = await import("node:crypto");
		const expectedSha = createHash("sha256").update(bundleSrc).digest("hex");
		expect(manifest.sha).toBe(expectedSha);

		// Post-PR 2 (sandbox-plugin-architecture §2.2/2.6): the emitted bundle
		// must route action dispatch through `globalThis.__sdk.dispatchAction`
		// (installed as a locked global by the sandbox-store's dispatcher
		// IIFE). Legacy `__dispatchAction` / `__hostCallAction` / `__emitEvent`
		// references must NOT appear in tenant bundles.
		expect(bundleSrc).toContain("globalThis.__sdk");
		expect(bundleSrc).not.toContain("__dispatchAction");
		expect(bundleSrc).not.toContain("__hostCallAction");
		expect(bundleSrc).not.toContain("__emitEvent");
	});

	it("generates JSON Schema for input, output, and trigger body", async () => {
		const { outDir } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "basic")) as {
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
		const manifest = (await readWorkflowManifest(outDir, "no_define")) as {
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
		const manifest = (await readWorkflowManifest(outDir, "custom-name")) as {
			name: string;
			module: string;
		};
		expect(manifest.name).toBe("custom-name");
		expect(manifest.module).toBe("custom-name.js");
	});
});

describe("workflowPlugin: HTTP trigger entry", () => {
	it("fails the build when an HTTP trigger export name contains non-URL-safe characters", async () => {
		await expect(
			buildFixture({
				files: { "bad.ts": TRIGGER_NON_URL_SAFE_NAME },
				workflows: ["./bad.ts"],
			}),
		).rejects.toThrow(/trigger export name ".+" must match/);
	});

	it("accepts an HTTP trigger export name with a leading underscore", async () => {
		const { outDir } = await buildFixture({
			files: { "u.ts": TRIGGER_UNDERSCORE_PREFIX_NAME },
			workflows: ["./u.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "u")) as {
			triggers: Array<{ name: string }>;
		};
		expect(manifest.triggers[0]?.name).toBe("_privateHook");
	});
});

describe("workflowPlugin: cron trigger entry", () => {
	it("emits cron descriptor with author-supplied tz", async () => {
		const { outDir } = await buildFixture({
			files: { "cr.ts": CRON_WORKFLOW_EXPLICIT_TZ },
			workflows: ["./cr.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "cr")) as {
			triggers: Array<{
				name: string;
				type: string;
				schedule?: string;
				tz?: string;
				inputSchema?: Record<string, unknown>;
				outputSchema?: Record<string, unknown>;
				path?: string;
			}>;
		};
		expect(manifest.triggers).toHaveLength(1);
		const t = manifest.triggers[0];
		expect(t?.name).toBe("daily");
		expect(t?.type).toBe("cron");
		expect(t?.schedule).toBe("0 9 * * *");
		expect(t?.tz).toBe("Europe/Berlin");
		expect(t?.inputSchema).toBeDefined();
		expect(t?.outputSchema).toBeDefined();
		// No HTTP-specific fields leak into a cron descriptor.
		expect(t?.path).toBeUndefined();
	});

	it("defaults cron tz to the build host IANA zone when omitted", async () => {
		const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const { outDir } = await buildFixture({
			files: { "cr2.ts": CRON_WORKFLOW_DEFAULT_TZ },
			workflows: ["./cr2.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "cr2")) as {
			triggers: Array<{ name: string; tz?: string }>;
		};
		expect(manifest.triggers[0]?.name).toBe("heartbeat");
		expect(manifest.triggers[0]?.tz).toBe(hostTz);
	});

	it("emits both HTTP and cron triggers in the same workflow", async () => {
		const { outDir } = await buildFixture({
			files: { "mixed.ts": CRON_AND_HTTP_WORKFLOW },
			workflows: ["./mixed.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "mixed")) as {
			triggers: Array<{ name: string; type: string }>;
		};
		expect(manifest.triggers).toHaveLength(2);
		const types = new Set(manifest.triggers.map((t) => t.type));
		expect(types.has("http")).toBe(true);
		expect(types.has("cron")).toBe(true);
	});
});

describe("workflowPlugin: manual trigger entry", () => {
	it("emits manual descriptor with default input/output schemas", async () => {
		const { outDir } = await buildFixture({
			files: { "mt.ts": MANUAL_WORKFLOW_DEFAULT_SCHEMAS },
			workflows: ["./mt.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "mt")) as {
			triggers: Array<{
				name: string;
				type: string;
				inputSchema?: Record<string, unknown>;
				outputSchema?: Record<string, unknown>;
				method?: string;
				schedule?: string;
				tz?: string;
			}>;
		};
		expect(manifest.triggers).toHaveLength(1);
		const t = manifest.triggers[0];
		expect(t?.name).toBe("rerun");
		expect(t?.type).toBe("manual");
		expect(t?.inputSchema).toBeDefined();
		expect(t?.outputSchema).toBeDefined();
		// No http- or cron-specific fields leak into a manual descriptor.
		expect(t?.method).toBeUndefined();
		expect(t?.schedule).toBeUndefined();
		expect(t?.tz).toBeUndefined();
	});

	it("emits manual descriptor with author-provided input/output schemas", async () => {
		const { outDir } = await buildFixture({
			files: { "mt2.ts": MANUAL_WORKFLOW_AUTHOR_SCHEMAS },
			workflows: ["./mt2.ts"],
		});
		const manifest = (await readWorkflowManifest(outDir, "mt2")) as {
			triggers: Array<{
				name: string;
				type: string;
				inputSchema: Record<string, unknown>;
				outputSchema: Record<string, unknown>;
			}>;
		};
		expect(manifest.triggers).toHaveLength(1);
		const t = manifest.triggers[0];
		expect(t?.name).toBe("reprocessOrder");
		expect(t?.type).toBe("manual");
		const props = (t?.inputSchema as { properties?: Record<string, unknown> })
			.properties;
		expect(props).toBeDefined();
		expect(props?.id).toBeDefined();
	});

	it("fails the build when a manual trigger export name is not URL-safe", async () => {
		await expect(
			buildFixture({
				files: { "bad.ts": MANUAL_WORKFLOW_INVALID_NAME },
				workflows: ["./bad.ts"],
			}),
		).rejects.toThrow(/\$weird/);
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

	it("fails when an action is declared detached from its export", async () => {
		await expect(
			buildFixture({
				files: { "detached.ts": ACTION_DETACHED_EXPORT },
				workflows: ["./detached.ts"],
			}),
		).rejects.toThrow(ERR_ACTION_NOT_TRANSFORMED);
	});

	it("fails when an action is default-exported", async () => {
		await expect(
			buildFixture({
				files: { "default.ts": ACTION_DEFAULT_EXPORT },
				workflows: ["./default.ts"],
			}),
		).rejects.toThrow(ERR_ACTION_DEFAULT_EXPORT);
	});

	it("fails when an action is wrapped in a factory (not a direct call)", async () => {
		await expect(
			buildFixture({
				files: { "factory.ts": ACTION_FACTORY_WRAPPER },
				workflows: ["./factory.ts"],
			}),
		).rejects.toThrow(ERR_ACTION_NOT_TRANSFORMED);
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
