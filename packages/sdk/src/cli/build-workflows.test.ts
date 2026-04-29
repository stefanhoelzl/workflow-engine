import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type BuildWorkflowsResult,
	buildWorkflows,
	type UnsealedWorkflowManifest,
} from "./build-workflows.js";

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
const EXPORT_ON_EVENT_RE = /exports\.onEvent\s*=/;
const EXPORT_SEND_NOTIFICATION_RE = /exports\.sendNotification\s*=/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

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

async function buildFixture(
	args: BuildFixtureArgs,
): Promise<{ result: BuildWorkflowsResult; dir: string }> {
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
	const result = await buildWorkflows({
		cwd: dir,
		workflows: args.workflows,
		skipTypecheck: true,
	});
	return { result, dir };
}

function getManifest(
	result: BuildWorkflowsResult,
	name: string,
): UnsealedWorkflowManifest {
	const wf = result.manifest.workflows.find((w) => w.name === name);
	if (!wf) {
		throw new Error(`workflow "${name}" not in manifest`);
	}
	return wf;
}

function getBundle(result: BuildWorkflowsResult, name: string): string {
	const src = result.files.get(`${name}.js`);
	if (!src) {
		throw new Error(`${name}.js missing from build result`);
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
	request: { body: z.object({ id: z.string() }) },
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

export const inner = action({
	input: z.object({}),
	output: z.string(),
	handler: async () => "x",
});

export { inner as alias };
`;

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
	request: { body: z.object({}) },
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

describe("buildWorkflows: brand-based discovery", () => {
	it("returns per-workflow JS bytes and manifest with actions and triggers", async () => {
		const { result } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		const manifest = getManifest(result, "basic");
		expect(manifest.name).toBe("basic");
		expect(manifest.module).toBe("basic.js");
		expect(manifest.sha).toMatch(SHA256_HEX_RE);
		expect(manifest.env).toEqual({});
		expect(manifest.actions).toHaveLength(1);
		expect(manifest.actions[0]?.name).toBe("sendNotification");
		expect(manifest.triggers).toHaveLength(1);
		expect(manifest.triggers[0]?.name).toBe("onEvent");
		const trigger = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(trigger.type).toBe("http");
		expect(trigger.method).toBe("POST");
		expect(trigger.path).toBeUndefined();
		expect(trigger.params).toBeUndefined();
		expect(trigger.query).toBeUndefined();

		const bundleSrc = getBundle(result, "basic");
		expect(bundleSrc).toMatch(EXPORT_ON_EVENT_RE);
		expect(bundleSrc).toContain('name: "sendNotification"');
		expect(bundleSrc).toMatch(EXPORT_SEND_NOTIFICATION_RE);

		const { createHash } = await import("node:crypto");
		const expectedSha = createHash("sha256").update(bundleSrc).digest("hex");
		expect(manifest.sha).toBe(expectedSha);

		expect(bundleSrc).toContain("globalThis.__sdk");
		expect(bundleSrc).not.toContain("__dispatchAction");
		expect(bundleSrc).not.toContain("__hostCallAction");
		expect(bundleSrc).not.toContain("__emitEvent");
	});

	it("emits open '{}' JSON Schema when action input/output are omitted", async () => {
		const SCHEMALESS_ACTION = `
import { action, defineWorkflow } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const passthrough = action({
	handler: async (x) => x,
});
`;
		const { result } = await buildFixture({
			files: { "schemaless.ts": SCHEMALESS_ACTION },
			workflows: ["./schemaless.ts"],
		});
		const manifest = getManifest(result, "schemaless");
		const action = manifest.actions[0];
		expect(action).toBeDefined();
		// z.any() → JSON Schema with only the $schema marker. After
		// stripping/reading via toJSONSchema(), no `type` constraint, no
		// `properties`, and no `required` — i.e. accepts anything.
		const inputSchema = action?.input as Record<string, unknown>;
		expect(inputSchema.type).toBeUndefined();
		expect(inputSchema.properties).toBeUndefined();
		expect(inputSchema.required).toBeUndefined();
		const outputSchema = action?.output as Record<string, unknown>;
		expect(outputSchema.type).toBeUndefined();
		expect(outputSchema.properties).toBeUndefined();
	});

	it("generates JSON Schema for input, output, and trigger body", async () => {
		const { result } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		const manifest = getManifest(result, "basic");
		const action = manifest.actions[0];
		expect(action).toBeDefined();
		const inputSchema = action?.input as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(inputSchema.type).toBe("object");
		expect(inputSchema.properties).toHaveProperty("message");
		expect(inputSchema.required).toContain("message");

		const outputSchema = action?.output as {
			type: string;
			properties: Record<string, unknown>;
		};
		expect(outputSchema.type).toBe("object");
		expect(outputSchema.properties).toHaveProperty("ok");

		const trigger = manifest.triggers[0] as {
			request: { body: Record<string, unknown> };
		};
		const bodySchema = trigger.request.body as {
			type: string;
			properties: Record<string, unknown>;
		};
		expect(bodySchema.type).toBe("object");
		expect(bodySchema.properties).toHaveProperty("id");
	});
});

describe("buildWorkflows: name derivation", () => {
	it("defaults workflow name to the file's filestem", async () => {
		const { result } = await buildFixture({
			files: { "no_define.ts": NO_DEFINE_WORKFLOW },
			workflows: ["./no_define.ts"],
		});
		const manifest = getManifest(result, "no_define");
		expect(manifest.name).toBe("no_define");
		expect(manifest.module).toBe("no_define.js");
		expect(manifest.env).toEqual({});
	});

	it("uses explicit defineWorkflow({name}) when provided", async () => {
		const { result } = await buildFixture({
			files: { "wf.ts": NAMED_WORKFLOW },
			workflows: ["./wf.ts"],
		});
		const manifest = getManifest(result, "custom-name");
		expect(manifest.name).toBe("custom-name");
		expect(manifest.module).toBe("custom-name.js");
	});
});

describe("buildWorkflows: HTTP trigger entry", () => {
	it("fails the build when an HTTP trigger export name contains non-URL-safe characters", async () => {
		await expect(
			buildFixture({
				files: { "bad.ts": TRIGGER_NON_URL_SAFE_NAME },
				workflows: ["./bad.ts"],
			}),
		).rejects.toThrow(/trigger export name ".+" must match/);
	});

	it("accepts an HTTP trigger export name with a leading underscore", async () => {
		const { result } = await buildFixture({
			files: { "u.ts": TRIGGER_UNDERSCORE_PREFIX_NAME },
			workflows: ["./u.ts"],
		});
		const manifest = getManifest(result, "u");
		expect(manifest.triggers[0]?.name).toBe("_privateHook");
	});
});

describe("buildWorkflows: cron trigger entry", () => {
	it("emits cron descriptor with author-supplied tz", async () => {
		const { result } = await buildFixture({
			files: { "cr.ts": CRON_WORKFLOW_EXPLICIT_TZ },
			workflows: ["./cr.ts"],
		});
		const manifest = getManifest(result, "cr");
		expect(manifest.triggers).toHaveLength(1);
		const t = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(t.name).toBe("daily");
		expect(t.type).toBe("cron");
		expect(t.schedule).toBe("0 9 * * *");
		expect(t.tz).toBe("Europe/Berlin");
		expect(t.inputSchema).toBeDefined();
		expect(t.outputSchema).toBeDefined();
		expect(t.path).toBeUndefined();
	});

	it("defaults cron tz to the build host IANA zone when omitted", async () => {
		const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const { result } = await buildFixture({
			files: { "cr2.ts": CRON_WORKFLOW_DEFAULT_TZ },
			workflows: ["./cr2.ts"],
		});
		const manifest = getManifest(result, "cr2");
		const t = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(t.name).toBe("heartbeat");
		expect(t.tz).toBe(hostTz);
	});

	it("emits both HTTP and cron triggers in the same workflow", async () => {
		const { result } = await buildFixture({
			files: { "mixed.ts": CRON_AND_HTTP_WORKFLOW },
			workflows: ["./mixed.ts"],
		});
		const manifest = getManifest(result, "mixed");
		expect(manifest.triggers).toHaveLength(2);
		const types = new Set(manifest.triggers.map((t) => t.type));
		expect(types.has("http")).toBe(true);
		expect(types.has("cron")).toBe(true);
	});
});

describe("buildWorkflows: manual trigger entry", () => {
	it("emits manual descriptor with default input/output schemas", async () => {
		const { result } = await buildFixture({
			files: { "mt.ts": MANUAL_WORKFLOW_DEFAULT_SCHEMAS },
			workflows: ["./mt.ts"],
		});
		const manifest = getManifest(result, "mt");
		expect(manifest.triggers).toHaveLength(1);
		const t = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(t.name).toBe("rerun");
		expect(t.type).toBe("manual");
		expect(t.inputSchema).toBeDefined();
		expect(t.outputSchema).toBeDefined();
		expect(t.method).toBeUndefined();
		expect(t.schedule).toBeUndefined();
		expect(t.tz).toBeUndefined();
	});

	it("emits manual descriptor with author-provided input/output schemas", async () => {
		const { result } = await buildFixture({
			files: { "mt2.ts": MANUAL_WORKFLOW_AUTHOR_SCHEMAS },
			workflows: ["./mt2.ts"],
		});
		const manifest = getManifest(result, "mt2");
		const t = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(t.name).toBe("reprocessOrder");
		expect(t.type).toBe("manual");
		const inputSchema = t.inputSchema as {
			properties?: Record<string, unknown>;
		};
		expect(inputSchema.properties).toBeDefined();
		expect(inputSchema.properties?.id).toBeDefined();
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

const WS_WORKFLOW_DEFAULT_RESPONSE = `
import { defineWorkflow, wsTrigger, z } from "@workflow-engine/sdk";

export default defineWorkflow();
export const echo = wsTrigger({
    request: z.object({ greet: z.string() }),
    handler: async ({ data }) => ({ echo: data.greet }),
});
`;

const WS_WORKFLOW_AUTHOR_RESPONSE = `
import { defineWorkflow, wsTrigger, z } from "@workflow-engine/sdk";

export default defineWorkflow();
export const chat = wsTrigger({
    request: z.object({ greet: z.string() }),
    response: z.object({ echo: z.string() }),
    handler: async ({ data }) => ({ echo: data.greet }),
});
`;

const WS_WORKFLOW_INVALID_NAME = `
import { defineWorkflow, wsTrigger, z } from "@workflow-engine/sdk";

export default defineWorkflow();
export const $weird = wsTrigger({
    request: z.object({}),
    handler: async () => "ok",
});
`;

const WS_AND_HTTP_WORKFLOW = `
import { defineWorkflow, httpTrigger, wsTrigger, z } from "@workflow-engine/sdk";

export default defineWorkflow();
export const echoHttp = httpTrigger({
    handler: async () => ({ status: 200, body: "ok" }),
});
export const echoWs = wsTrigger({
    request: z.object({ greet: z.string() }),
    handler: async ({ data }) => ({ echo: data.greet }),
});
`;

describe("buildWorkflows: ws trigger entry", () => {
	it("emits ws descriptor with default response schema", async () => {
		const { result } = await buildFixture({
			files: { "ws.ts": WS_WORKFLOW_DEFAULT_RESPONSE },
			workflows: ["./ws.ts"],
		});
		const manifest = getManifest(result, "ws");
		expect(manifest.triggers).toHaveLength(1);
		const t = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(t.name).toBe("echo");
		expect(t.type).toBe("ws");
		expect(t.request).toBeDefined();
		expect(t.response).toBeDefined();
		expect(t.inputSchema).toBeDefined();
		expect(t.outputSchema).toBeDefined();
		// Author-omitted response → z.any() → empty JSON Schema {}
		expect(Object.keys(t.response as object)).toHaveLength(0);
		expect(t.method).toBeUndefined();
		expect(t.schedule).toBeUndefined();
	});

	it("emits ws descriptor with author-provided response schema", async () => {
		const { result } = await buildFixture({
			files: { "ws2.ts": WS_WORKFLOW_AUTHOR_RESPONSE },
			workflows: ["./ws2.ts"],
		});
		const manifest = getManifest(result, "ws2");
		const t = manifest.triggers[0] as unknown as Record<string, unknown>;
		expect(t.name).toBe("chat");
		expect(t.type).toBe("ws");
		const responseSchema = t.response as {
			properties?: Record<string, unknown>;
		};
		expect(responseSchema.properties?.echo).toBeDefined();
		const inputSchema = t.inputSchema as {
			properties?: Record<string, unknown>;
		};
		expect(inputSchema.properties?.data).toBeDefined();
	});

	it("fails the build when a ws trigger export name is not URL-safe", async () => {
		await expect(
			buildFixture({
				files: { "bad.ts": WS_WORKFLOW_INVALID_NAME },
				workflows: ["./bad.ts"],
			}),
		).rejects.toThrow(/\$weird/);
	});

	it("emits both http and ws entries when one workflow declares both", async () => {
		const { result } = await buildFixture({
			files: { "mixed.ts": WS_AND_HTTP_WORKFLOW },
			workflows: ["./mixed.ts"],
		});
		const manifest = getManifest(result, "mixed");
		expect(manifest.triggers).toHaveLength(2);
		const types = manifest.triggers.map(
			(t) => (t as unknown as Record<string, unknown>).type,
		);
		expect(types.sort()).toEqual(["http", "ws"]);
	});
});

describe("buildWorkflows: build failures", () => {
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

	it("emits strip=true on declared request.headers in the manifest", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const signed = httpTrigger({
	request: {
		headers: z.object({ "x-hub-signature-256": z.string() }),
	},
	handler: async () => ({}),
});
`;
		const { result } = await buildFixture({
			files: { "signed.ts": wf },
			workflows: ["./signed.ts"],
		});
		const manifest = getManifest(result, "signed");
		const trigger = manifest.triggers[0] as {
			request: { headers: Record<string, unknown> };
		};
		expect(trigger.request.headers.strip).toBe(true);
		expect(trigger.request.headers.additionalProperties).toBe(false);
	});

	it("emits strip=true on default empty-record request.headers", async () => {
		const wf = `
import { defineWorkflow, httpTrigger } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const noHeaders = httpTrigger({
	handler: async () => ({}),
});
`;
		const { result } = await buildFixture({
			files: { "default.ts": wf },
			workflows: ["./default.ts"],
		});
		const manifest = getManifest(result, "default");
		const trigger = manifest.triggers[0] as {
			request: { headers: Record<string, unknown> };
		};
		expect(trigger.request.headers.strip).toBe(true);
		expect(trigger.request.headers.additionalProperties).toBe(false);
		expect(
			Object.keys(
				trigger.request.headers.properties as Record<string, unknown>,
			),
		).toEqual([]);
	});

	it("does NOT fail when author writes .loose() on request.headers (auto-wrap is overridable)", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const loose = httpTrigger({
	request: {
		headers: z.object({ "x-trace-id": z.string() }).loose(),
	},
	handler: async () => ({}),
});
`;
		const { result } = await buildFixture({
			files: { "loose.ts": wf },
			workflows: ["./loose.ts"],
		});
		const manifest = getManifest(result, "loose");
		const trigger = manifest.triggers[0] as {
			request: { headers: Record<string, unknown> };
		};
		// .loose() emits additionalProperties: {} (any). No `strip` marker
		// added — author chose passthrough explicitly; SDK respects it.
		expect(trigger.request.headers.additionalProperties).toEqual({});
		expect("strip" in trigger.request.headers).toBe(false);
	});

	it("does NOT fail when author writes .meta({ strip: false }) on request.headers", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const explicitStrict = httpTrigger({
	request: {
		headers: z.object({ "x-trace-id": z.string() }).meta({ strip: false }),
	},
	handler: async () => ({}),
});
`;
		const { result } = await buildFixture({
			files: { "explicit.ts": wf },
			workflows: ["./explicit.ts"],
		});
		const manifest = getManifest(result, "explicit");
		const trigger = manifest.triggers[0] as {
			request: { headers: Record<string, unknown> };
		};
		// Author's `strip: false` wins over the SDK auto-wrap.
		expect(trigger.request.headers.strip).toBe(false);
	});

	it("fails when an action's input is not a Zod schema", async () => {
		const badAction = `
import { action, defineWorkflow } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

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

describe("buildWorkflows: reserved response headers", () => {
	it("fails when response.headers declares a lowercase reserved name", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const sneaky = httpTrigger({
	response: {
		headers: z.object({ "set-cookie": z.string() }),
	},
	handler: async () => ({}),
});
`;
		await expect(
			buildFixture({
				files: { "sneaky.ts": wf },
				workflows: ["./sneaky.ts"],
			}),
		).rejects.toThrow(/reserved header "set-cookie"/);
	});

	it("fails when response.headers declares a capitalized reserved name", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const sneaky = httpTrigger({
	response: {
		headers: z.object({ "Set-Cookie": z.string() }),
	},
	handler: async () => ({}),
});
`;
		await expect(
			buildFixture({
				files: { "sneaky.ts": wf },
				workflows: ["./sneaky.ts"],
			}),
		).rejects.toThrow(/reserved header "Set-Cookie"/);
	});

	it("fails when response.headers declares a platform-invariant header (location)", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const redir = httpTrigger({
	response: {
		headers: z.object({ "location": z.string() }),
	},
	handler: async () => ({}),
});
`;
		await expect(
			buildFixture({
				files: { "redir.ts": wf },
				workflows: ["./redir.ts"],
			}),
		).rejects.toThrow(/reserved header "location"/);
	});

	it("succeeds when response.headers contains only non-reserved names", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const ok = httpTrigger({
	response: {
		headers: z.object({ "x-app-version": z.string() }),
	},
	handler: async () => ({ headers: { "x-app-version": "1.0" } }),
});
`;
		const { result } = await buildFixture({
			files: { "ok.ts": wf },
			workflows: ["./ok.ts"],
		});
		const manifest = getManifest(result, "ok");
		expect(manifest.triggers).toHaveLength(1);
	});

	it("succeeds for an open-record response.headers schema (no static properties to check)", async () => {
		const wf = `
import { defineWorkflow, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const open = httpTrigger({
	response: {
		headers: z.record(z.string(), z.string()),
	},
	handler: async () => ({}),
});
`;
		const { result } = await buildFixture({
			files: { "open.ts": wf },
			workflows: ["./open.ts"],
		});
		const manifest = getManifest(result, "open");
		expect(manifest.triggers).toHaveLength(1);
	});
});

describe("buildWorkflows: secret bindings", () => {
	const WITH_SECRETS = `
import { action, defineWorkflow, env, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		REGION: env({ default: "us-east-1" }),
		TOKEN: env({ name: "TOKEN", secret: true }),
		STRIPE_KEY: env({ secret: true }),
	},
});

export const call = action({
	input: z.object({}),
	output: z.object({}),
	handler: async () => ({}),
});
`;

	const PLAINTEXT_ONLY = `
import { action, defineWorkflow, env, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		REGION: env({ default: "us-east-1" }),
	},
});

export const call = action({
	input: z.object({}),
	output: z.object({}),
	handler: async () => ({}),
});
`;

	it("routes secret bindings into manifest.secretBindings, not manifest.env", async () => {
		// biome-ignore lint/style/noProcessEnv: test-only; restored below
		process.env.TOKEN = "build-time-presence-only";
		// biome-ignore lint/style/noProcessEnv: test-only; restored below
		process.env.STRIPE_KEY = "build-time-presence-only";
		try {
			const { result } = await buildFixture({
				files: { "s.ts": WITH_SECRETS },
				workflows: ["./s.ts"],
			});
			const manifest = getManifest(result, "s");
			expect(manifest.env).toEqual({ REGION: "us-east-1" });
			expect(manifest.secretBindings).toBeDefined();
			expect(new Set(manifest.secretBindings)).toEqual(
				new Set(["TOKEN", "STRIPE_KEY"]),
			);
		} finally {
			// biome-ignore lint/style/noProcessEnv: test-only restore
			process.env.TOKEN = undefined;
			// biome-ignore lint/style/noProcessEnv: test-only restore
			process.env.STRIPE_KEY = undefined;
		}
	});

	it("does not include a secret's plaintext value anywhere in the bundle", async () => {
		// biome-ignore lint/style/noProcessEnv: test-only; restored below
		process.env.TOKEN = "SHOULD_NOT_APPEAR";
		// biome-ignore lint/style/noProcessEnv: test-only; restored below
		process.env.STRIPE_KEY = "ALSO_SHOULD_NOT_APPEAR";
		try {
			const { result } = await buildFixture({
				files: { "s.ts": WITH_SECRETS },
				workflows: ["./s.ts"],
			});
			const bundleSrc = getBundle(result, "s");
			const manifestRaw = JSON.stringify(getManifest(result, "s"));
			expect(bundleSrc).not.toContain("SHOULD_NOT_APPEAR");
			expect(manifestRaw).not.toContain("SHOULD_NOT_APPEAR");
			expect(bundleSrc).not.toContain("ALSO_SHOULD_NOT_APPEAR");
			expect(manifestRaw).not.toContain("ALSO_SHOULD_NOT_APPEAR");
		} finally {
			// biome-ignore lint/style/noProcessEnv: test-only restore
			process.env.TOKEN = undefined;
			// biome-ignore lint/style/noProcessEnv: test-only restore
			process.env.STRIPE_KEY = undefined;
		}
	});

	it("omits secretBindings when no secret env is declared", async () => {
		const { result } = await buildFixture({
			files: { "p.ts": PLAINTEXT_ONLY },
			workflows: ["./p.ts"],
		});
		const manifest = getManifest(result, "p");
		expect(manifest.env).toEqual({ REGION: "us-east-1" });
		expect(manifest.secretBindings).toBeUndefined();
	});
});

describe("buildWorkflows: artifact shape", () => {
	it("returns files keyed on workflow name with .js suffix", async () => {
		const { result } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		expect([...result.files.keys()]).toEqual(["basic.js"]);
	});

	it("does not write anything to dist/", async () => {
		const { dir, result } = await buildFixture({
			files: { "basic.ts": BASIC_WORKFLOW },
			workflows: ["./basic.ts"],
		});
		// buildWorkflows is in-memory; no dist/ should appear.
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, "dist"))).toBe(false);
		expect(result.files.size).toBeGreaterThan(0);
		expect(result.manifest.workflows.length).toBeGreaterThan(0);
	});
});
