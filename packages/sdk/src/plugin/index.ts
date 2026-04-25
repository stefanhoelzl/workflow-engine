import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
// writeFile retained for packTarGz output; keep import.
import { pipeline } from "node:stream/promises";
import { createContext, runInContext } from "node:vm";
import { createGzip } from "node:zlib";
import { IIFE_NAMESPACE } from "@workflow-engine/core";
import MagicString from "magic-string";
import { pack as tarPack } from "tar-stream";
import ts from "typescript";
import { build, type Plugin, type ResolvedConfig } from "vite";
import {
	type Action,
	type CronTrigger,
	type HttpTrigger,
	isAction,
	isCronTrigger,
	isHttpTrigger,
	isManualTrigger,
	isWorkflow,
	type ManualTrigger,
	type Workflow,
} from "../index.js";

// URL-safe trigger-export-name regex. Matches a JS identifier (no `$`),
// length-capped at 63 to mirror the owner regex. Enforced at manifest
// emission so the export name can be used directly as the webhook URL's
// trailing segment — see the `http-trigger` capability spec.
const TRIGGER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

interface WorkflowPluginOptions {
	workflows: string[];
}

interface PluginContext {
	error(message: string): never;
}

const typecheckCompilerOptions: ts.CompilerOptions = {
	strict: true,
	noUncheckedIndexedAccess: true,
	exactOptionalPropertyTypes: true,
	verbatimModuleSyntax: true,
	noEmit: true,
	isolatedModules: true,
	skipLibCheck: true,
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

function typecheckWorkflows(workflows: string[], root: string): void {
	const rootNames = workflows.map((wf) => resolve(root, wf));
	const program = ts.createProgram(rootNames, typecheckCompilerOptions);
	const diagnostics = ts.getPreEmitDiagnostics(program);

	if (diagnostics.length > 0) {
		const host: ts.FormatDiagnosticsHost = {
			getCanonicalFileName: (f) => f,
			getCurrentDirectory: () => root,
			getNewLine: () => "\n",
		};
		const formatted = ts.formatDiagnosticsWithColorAndContext(
			diagnostics,
			host,
		);
		throw new Error(`TypeScript errors in workflows:\n${formatted}`);
	}
}

const EMPTY_VIRTUAL_ID = "\0workflow-engine:empty";

// The workflow-engine plugin doesn't emit through Vite's lib mode — it
// sub-builds each workflow during `generateBundle`. We still need to pass
// Vite/Rollup a non-empty input, so we install a tiny virtual module and
// discard the resulting chunk before writing.
function buildPluginViteConfig(): Parameters<
	Exclude<NonNullable<Plugin["config"]>, { handler: unknown }>
>[0] {
	return {
		build: {
			outDir: "dist",
			emptyOutDir: true,
			lib: {
				entry: {},
				formats: ["es"],
			},
			rollupOptions: {
				input: EMPTY_VIRTUAL_ID,
			},
		},
	};
}

async function packTarGz(
	outPath: string,
	files: readonly { name: string; content: string }[],
): Promise<void> {
	const packer = tarPack();
	for (const file of files) {
		packer.entry({ name: file.name }, file.content);
	}
	packer.finalize();

	const chunks: Buffer[] = [];
	const gzip = createGzip();
	gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
	await pipeline(packer, gzip);
	await writeFile(outPath, Buffer.concat(chunks));
}

async function runAllWorkflows(
	options: WorkflowPluginOptions,
	resolvedConfig: ResolvedConfig,
	ctx: PluginContext,
): Promise<void> {
	const outDir = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
	const built = await Promise.all(
		options.workflows.map((wf) => {
			const workflowPath = resolve(resolvedConfig.root, wf);
			const filestem = basename(wf, ".ts");
			return buildOneWorkflow({
				workflowPath,
				filestem,
				root: resolvedConfig.root,
				ctx,
			});
		}),
	);

	// Assemble the owner tarball:
	//   dist/bundle.tar.gz
	//     manifest.json   ({ workflows: [...] })
	//     <name>.js       (one per workflow)
	const ownerManifest = { workflows: built.map((b) => b.manifest) };
	const manifestJson = `${JSON.stringify(ownerManifest, null, 2)}\n`;

	const files: { name: string; content: string }[] = [
		{ name: "manifest.json", content: manifestJson },
	];
	for (const b of built) {
		files.push({ name: `${b.manifest.name}.js`, content: b.bundleSource });
	}
	await mkdir(outDir, { recursive: true });
	const tarGzPath = join(outDir, "bundle.tar.gz");
	await packTarGz(tarGzPath, files);

	// biome-ignore lint/suspicious/noConsole: intentional build output
	console.log(
		`Owner bundle: ${built.length} workflow(s) packed to ${tarGzPath}`,
	);
}

function workflowPlugin(options: WorkflowPluginOptions): Plugin {
	let resolvedConfig: ResolvedConfig;
	return {
		name: "workflow-engine",
		configResolved(config) {
			resolvedConfig = config;
		},
		buildStart() {
			if (!resolvedConfig.build.watch) {
				typecheckWorkflows(options.workflows, resolvedConfig.root);
				// biome-ignore lint/suspicious/noConsole: intentional build output
				console.log("TypeScript check passed");
			}
		},
		config() {
			return buildPluginViteConfig();
		},
		resolveId(id) {
			if (id === EMPTY_VIRTUAL_ID) {
				return id;
			}
		},
		load(id) {
			if (id === EMPTY_VIRTUAL_ID) {
				return "export {};";
			}
		},
		async generateBundle(_opts, bundle) {
			// Discard the placeholder chunk(s) Vite generated for the empty entry.
			for (const key of Object.keys(bundle)) {
				delete bundle[key];
			}
			await runAllWorkflows(options, resolvedConfig, this);
		},
	};
}

interface BuildOneWorkflowArgs {
	workflowPath: string;
	filestem: string;
	root: string;
	ctx: PluginContext;
}

interface BuiltWorkflow {
	manifest: BuiltManifest;
	bundleSource: string;
}

async function buildOneWorkflow(
	args: BuildOneWorkflowArgs,
): Promise<BuiltWorkflow> {
	const { workflowPath, filestem, root, ctx } = args;

	// Pass 1 — manifest build, zod inlined. The VM reads the branded
	// exports' zod-bearing config properties so the plugin can emit JSON
	// Schemas into the manifest. This bundle is discarded.
	const manifestSource = await bundleWorkflowForManifest(workflowPath, root);
	const mod = runIifeInVmContext(manifestSource, filestem, ctx);

	// Pass 2 — runtime build, factory configs stripped of `input`/`output`/
	// `body`/`responseBody`. Zod tree-shakes out. This bundle is what ships
	// to the sandbox, and its sha goes into the manifest.
	const bundleSource = await bundleWorkflowForRuntime(workflowPath, root);
	const sha = createHash("sha256").update(bundleSource).digest("hex");
	const manifest = buildManifest(mod, filestem, sha, ctx);

	// biome-ignore lint/suspicious/noConsole: intentional build output
	console.log(
		`Workflow "${manifest.name}": ${manifest.actions.length} action(s), ${manifest.triggers.length} trigger(s) bundled`,
	);
	return { manifest, bundleSource };
}

function runIifeInVmContext(
	bundleSource: string,
	filestem: string,
	ctx: PluginContext,
): Record<string, unknown> {
	// The IIFE bundle is a script that declares `var <IIFE_NAMESPACE> = (...)(...)`.
	// Running it via vm.createContext()/vm.runInContext() gives the script a
	// dedicated global object that we can inspect (and discard) afterwards —
	// `var` bindings bind to that sandbox's global, not this process's.
	//
	// Branded objects still work across contexts because the SDK uses
	// `Symbol.for(...)` for its brand keys, which are shared between all
	// V8 contexts in the same process.
	//
	// Inject the host's `process.env` so workflow authors can reference real
	// env vars at build time (e.g. `env({ name: "API_URL" })`). The vm
	// sandbox does not inherit globals, so without this `defineWorkflow`'s
	// `getDefaultEnvSource()` returns `{}` and any non-default env binding
	// throws "Missing environment variable".
	const sandboxGlobal: Record<string, unknown> = {
		// biome-ignore lint/style/noProcessEnv: build-time wiring; workflow authors deliberately reference host env vars via env()
		process: { env: process.env },
	};
	const context = createContext(sandboxGlobal);
	try {
		runInContext(bundleSource, context, { filename: `${filestem}.js` });
	} catch (error: unknown) {
		ctx.error(
			`Failed to evaluate bundled workflow "${filestem}": ${errorMessage(error)}`,
		);
	}
	const ns = sandboxGlobal[IIFE_NAMESPACE];
	if (typeof ns !== "object" || ns === null) {
		ctx.error(
			`Bundled workflow "${filestem}": IIFE did not assign exports to globalThis.${IIFE_NAMESPACE}`,
		);
	}
	return ns as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

interface ManifestActionEntry {
	name: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
}

interface ManifestHttpTriggerEntry {
	name: string;
	type: "http";
	method: string;
	body: Record<string, unknown>;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
}

interface ManifestCronTriggerEntry {
	name: string;
	type: "cron";
	schedule: string;
	tz: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
}

interface ManifestManualTriggerEntry {
	name: string;
	type: "manual";
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
}

type ManifestTriggerEntry =
	| ManifestHttpTriggerEntry
	| ManifestCronTriggerEntry
	| ManifestManualTriggerEntry;

interface BuiltManifest {
	name: string;
	module: string;
	sha: string;
	env: Record<string, string>;
	// Names of env bindings declared with `env({secret: true})`. The CLI
	// fetches the server public key at upload, seals each value from its
	// own `process.env[name]`, writes `manifest.secrets` + `secretsKeyId`,
	// and DELETES `secretBindings` before POSTing. The server's
	// `ManifestSchema` rejects bundles whose manifests still contain this
	// field (it is an intermediate build-artifact key only).
	secretBindings?: string[];
	actions: ManifestActionEntry[];
	triggers: ManifestTriggerEntry[];
}

interface DiscoveredExports {
	workflowEntries: [string, Workflow][];
	actionEntries: [string, Action][];
	httpTriggerEntries: [string, HttpTrigger][];
	cronTriggerEntries: [string, CronTrigger][];
	manualTriggerEntries: [string, ManualTrigger][];
}

function discoverExports(
	mod: Record<string, unknown>,
	filestem: string,
	ctx: PluginContext,
): DiscoveredExports {
	const workflowEntries: [string, Workflow][] = [];
	const actionEntries: [string, Action][] = [];
	const httpTriggerEntries: [string, HttpTrigger][] = [];
	const cronTriggerEntries: [string, CronTrigger][] = [];
	const manualTriggerEntries: [string, ManualTrigger][] = [];
	for (const [exportName, value] of Object.entries(mod)) {
		if (exportName === "default" && isAction(value)) {
			ctx.error(
				`Workflow "${filestem}": action cannot be a default export; use \`export const X = action({...})\``,
			);
		}
		if (isWorkflow(value)) {
			workflowEntries.push([exportName, value]);
		} else if (isAction(value)) {
			actionEntries.push([exportName, value]);
		} else if (isHttpTrigger(value)) {
			httpTriggerEntries.push([exportName, value]);
		} else if (isCronTrigger(value)) {
			cronTriggerEntries.push([exportName, value]);
		} else if (isManualTrigger(value)) {
			manualTriggerEntries.push([exportName, value]);
		}
	}
	return {
		workflowEntries,
		actionEntries,
		httpTriggerEntries,
		cronTriggerEntries,
		manualTriggerEntries,
	};
}

function buildActionEntries(
	entries: [string, Action][],
	workflowName: string,
	ctx: PluginContext,
): ManifestActionEntry[] {
	// Alias check first: if the same callable is exported under multiple
	// names, fail before any per-entry validation runs so the user sees the
	// most specific error.
	const exportNamesByAction = new Map<Action, string[]>();
	for (const [exportName, actionObj] of entries) {
		const list = exportNamesByAction.get(actionObj) ?? [];
		list.push(exportName);
		exportNamesByAction.set(actionObj, list);
	}
	for (const names of exportNamesByAction.values()) {
		if (names.length > 1) {
			ctx.error(
				`Workflow "${workflowName}": action exported under multiple names ("${names[0]}" and "${names[1]}"); action identity is the export name`,
			);
		}
	}

	const actions: ManifestActionEntry[] = [];
	for (const [exportName, actionObj] of entries) {
		// Every action must have been named at build time by the AST
		// transform. An empty name means the declaration didn't match
		// the `export const X = action({...})` pattern the transform
		// recognises; surface that as a build-time error rather than
		// letting the bundle ship and fail at first invocation.
		if (actionObj.name === "") {
			ctx.error(
				`Workflow "${workflowName}": action "${exportName}" was not transformed at build time. Actions must be declared as: export const ${exportName} = action({...})`,
			);
		}
		if (actionObj.name !== exportName) {
			ctx.error(
				`Workflow "${workflowName}": action "${exportName}" was built-time named "${actionObj.name}"; the name must match the export name`,
			);
		}
		const inputLabel = `action "${exportName}".input`;
		const outputLabel = `action "${exportName}".output`;
		assertZodSchema(actionObj.input, inputLabel, workflowName, ctx);
		assertZodSchema(actionObj.output, outputLabel, workflowName, ctx);
		actions.push({
			name: exportName,
			input: toJsonSchema(actionObj.input, inputLabel, workflowName, ctx),
			output: toJsonSchema(actionObj.output, outputLabel, workflowName, ctx),
		});
	}
	return actions;
}

// Host-side JSON Schema composition — replaces the zod composition the SDK
// used to do at bundle-load. Produces the same envelope shape toJSONSchema()
// emitted previously, as literals, so the runtime bundle never needs zod at
// its own module-init time.

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

function headersJsonSchema(): Record<string, unknown> {
	return {
		type: "object",
		propertyNames: { type: "string" },
		additionalProperties: { type: "string" },
	};
}

function stripDraftMarker(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	// The envelope carries "$schema" at the top level; children inherit it.
	// Produce a copy without the marker to match zod's prior composite output.
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === "$schema") {
			continue;
		}
		out[k] = v;
	}
	return out;
}

function composeHttpInputSchema(
	bodyJsonSchema: Record<string, unknown>,
	method: string,
): Record<string, unknown> {
	return {
		$schema: JSON_SCHEMA_DRAFT,
		type: "object",
		properties: {
			body: stripDraftMarker(bodyJsonSchema),
			headers: headersJsonSchema(),
			url: { type: "string" },
			method: { default: method, type: "string" },
		},
		required: ["body", "headers", "url", "method"],
		additionalProperties: false,
	};
}

function composeHttpOutputSchema(
	responseBodyJsonSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (responseBodyJsonSchema === undefined) {
		return {
			$schema: JSON_SCHEMA_DRAFT,
			type: "object",
			properties: {
				status: { type: "number" },
				body: {},
				headers: headersJsonSchema(),
			},
			additionalProperties: false,
		};
	}
	return {
		$schema: JSON_SCHEMA_DRAFT,
		type: "object",
		properties: {
			status: { type: "number" },
			body: stripDraftMarker(responseBodyJsonSchema),
			headers: headersJsonSchema(),
		},
		required: ["body"],
		additionalProperties: false,
	};
}

function cronInputJsonSchema(): Record<string, unknown> {
	return {
		$schema: JSON_SCHEMA_DRAFT,
		type: "object",
		properties: {},
		additionalProperties: false,
	};
}

function cronOutputJsonSchema(): Record<string, unknown> {
	return { $schema: JSON_SCHEMA_DRAFT };
}

// Zod emits `{type: "unknown"}` for z.unknown() in some configurations; mirror
// the historical "body:{}" form for the unbodied HTTP case.
function bodyJsonSchemaOrEmpty(
	body: unknown,
	label: string,
	workflowName: string,
	ctx: PluginContext,
): Record<string, unknown> {
	if (body === undefined) {
		// Default `body?: B = z.ZodUnknown` with nothing declared means
		// "accept anything" — matches zod's z.unknown().toJSONSchema().
		return {};
	}
	assertZodSchema(body, label, workflowName, ctx);
	return toJsonSchema(body, label, workflowName, ctx);
}

function buildTriggerEntry(
	exportName: string,
	trigger: HttpTrigger,
	workflowName: string,
	ctx: PluginContext,
): ManifestHttpTriggerEntry {
	if (typeof trigger !== "function") {
		ctx.error(
			`Workflow "${workflowName}": trigger "${exportName}" is missing a handler function`,
		);
	}
	if (!TRIGGER_NAME_RE.test(exportName)) {
		ctx.error(
			`Workflow "${workflowName}": trigger export name "${exportName}" must match ${TRIGGER_NAME_RE}`,
		);
	}
	const bodyLabel = `trigger "${exportName}".body`;
	const bodyJson = bodyJsonSchemaOrEmpty(
		trigger.body,
		bodyLabel,
		workflowName,
		ctx,
	);
	const responseBodyLabel = `trigger "${exportName}".responseBody`;
	let responseBodyJson: Record<string, unknown> | undefined;
	if (trigger.responseBody !== undefined) {
		assertZodSchema(trigger.responseBody, responseBodyLabel, workflowName, ctx);
		responseBodyJson = toJsonSchema(
			trigger.responseBody,
			responseBodyLabel,
			workflowName,
			ctx,
		);
	}
	return {
		name: exportName,
		type: "http",
		method: trigger.method,
		body: bodyJson,
		inputSchema: composeHttpInputSchema(bodyJson, trigger.method),
		outputSchema: composeHttpOutputSchema(responseBodyJson),
	};
}

function buildCronTriggerEntry(
	exportName: string,
	trigger: CronTrigger,
	workflowName: string,
	ctx: PluginContext,
): ManifestCronTriggerEntry {
	if (typeof trigger !== "function") {
		ctx.error(
			`Workflow "${workflowName}": cron trigger "${exportName}" is missing a handler function`,
		);
	}
	if (typeof trigger.schedule !== "string" || trigger.schedule === "") {
		ctx.error(
			`Workflow "${workflowName}": cron trigger "${exportName}" has no schedule`,
		);
	}
	if (typeof trigger.tz !== "string" || trigger.tz === "") {
		ctx.error(
			`Workflow "${workflowName}": cron trigger "${exportName}" has no tz (factory default resolution failed)`,
		);
	}
	return {
		name: exportName,
		type: "cron",
		schedule: trigger.schedule,
		tz: trigger.tz,
		inputSchema: cronInputJsonSchema(),
		outputSchema: cronOutputJsonSchema(),
	};
}

function buildManualTriggerEntry(
	exportName: string,
	trigger: ManualTrigger,
	workflowName: string,
	ctx: PluginContext,
): ManifestManualTriggerEntry {
	if (typeof trigger !== "function") {
		ctx.error(
			`Workflow "${workflowName}": manual trigger "${exportName}" is missing a handler function`,
		);
	}
	if (!TRIGGER_NAME_RE.test(exportName)) {
		ctx.error(
			`Workflow "${workflowName}": manual trigger export name "${exportName}" must match ${TRIGGER_NAME_RE}`,
		);
	}
	const inputSchemaLabel = `manual trigger "${exportName}".inputSchema`;
	assertZodSchema(trigger.inputSchema, inputSchemaLabel, workflowName, ctx);
	const outputSchemaLabel = `manual trigger "${exportName}".outputSchema`;
	assertZodSchema(trigger.outputSchema, outputSchemaLabel, workflowName, ctx);
	return {
		name: exportName,
		type: "manual",
		inputSchema: toJsonSchema(
			trigger.inputSchema,
			inputSchemaLabel,
			workflowName,
			ctx,
		),
		outputSchema: toJsonSchema(
			trigger.outputSchema,
			outputSchemaLabel,
			workflowName,
			ctx,
		),
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: manifest assembly threads discovery → validation → per-kind entry builders; each step is already a named helper
function buildManifest(
	mod: Record<string, unknown>,
	filestem: string,
	sha: string,
	ctx: PluginContext,
): BuiltManifest {
	const {
		workflowEntries,
		actionEntries,
		httpTriggerEntries,
		cronTriggerEntries,
		manualTriggerEntries,
	} = discoverExports(mod, filestem, ctx);

	if (workflowEntries.length > 1) {
		ctx.error(
			`Workflow "${filestem}": at most one defineWorkflow per file (found ${String(workflowEntries.length)})`,
		);
	}

	const workflow = workflowEntries[0]?.[1];
	// Empty string means "no explicit name" — post-refactor, defineWorkflow
	// returns `name: ""` rather than `undefined` when the config omits `name`,
	// so we fall back to the filestem via a truthy check.
	const name = workflow?.name || filestem;

	// Read the symbol-branded list of secret envNames the SDK's
	// defineWorkflow attached to the workflow at build time. Cross-VM
	// context safe because `Symbol.for` returns the same symbol across
	// contexts in the same process.
	const secretBindingsSymbol = Symbol.for(
		"@workflow-engine/workflow-secret-bindings",
	);
	const secretBindings = workflow
		? ((workflow as unknown as Record<symbol, unknown>)[secretBindingsSymbol] as
				| readonly string[]
				| undefined)
		: undefined;

	// Copy plaintext env entries into the manifest's `env` record, but
	// EXCLUDE secret bindings. At build time `wf.env.SECRET_X` is a sentinel
	// string (emitted by `resolveEnvRecord`) so author trigger-config code
	// can reference secrets before the CLI seals them. Those sentinels must
	// not land in `manifest.env` — the manifest schema requires `secrets`
	// keys to be disjoint from `env` keys, and `manifest.env` is
	// plaintext-only. Sentinels survive in trigger descriptor fields.
	const secretBindingSet = new Set(secretBindings ?? []);
	const env: Record<string, string> = {};
	if (workflow) {
		for (const [key, value] of Object.entries(workflow.env)) {
			if (secretBindingSet.has(key)) {
				continue;
			}
			env[key] = value;
		}
	}

	const actions = buildActionEntries(actionEntries, name, ctx);
	const triggers: ManifestTriggerEntry[] = [
		...httpTriggerEntries.map(([k, v]) => buildTriggerEntry(k, v, name, ctx)),
		...cronTriggerEntries.map(([k, v]) =>
			buildCronTriggerEntry(k, v, name, ctx),
		),
		...manualTriggerEntries.map(([k, v]) =>
			buildManualTriggerEntry(k, v, name, ctx),
		),
	];

	const built: BuiltManifest = {
		name,
		module: `${name}.js`,
		sha,
		env,
		actions,
		triggers,
	};
	if (secretBindings !== undefined && secretBindings.length > 0) {
		built.secretBindings = [...secretBindings];
	}
	return built;
}

// Schema-like detection: Zod schemas have a `parse` function and a `_zod`
// internal brand in v4. We check both for robustness.
function isZodLike(
	value: unknown,
): value is { parse: (x: unknown) => unknown } {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return typeof obj.parse === "function";
}

function assertZodSchema(
	value: unknown,
	label: string,
	workflowName: string,
	ctx: PluginContext,
): void {
	if (!isZodLike(value)) {
		ctx.error(
			`Workflow "${workflowName}": ${label} is not a Zod schema (expected an object with a .parse() method)`,
		);
	}
}

interface ZodLikeWithJsonSchema {
	// biome-ignore lint/style/useNamingConvention: mirrors Zod's public API name `toJSONSchema`
	toJSONSchema?: () => unknown;
}

function toJsonSchema(
	schema: unknown,
	label: string,
	workflowName: string,
	ctx: PluginContext,
): Record<string, unknown> {
	const candidate = schema as ZodLikeWithJsonSchema;
	if (typeof candidate.toJSONSchema !== "function") {
		ctx.error(
			`Workflow "${workflowName}": ${label} does not support toJSONSchema() (expected Zod v4)`,
		);
	}
	const result = candidate.toJSONSchema();
	if (typeof result !== "object" || result === null) {
		ctx.error(
			`Workflow "${workflowName}": ${label} toJSONSchema() returned non-object`,
		);
	}
	return result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AST transform: inject `name: "<exportName>"` into `action({...})` calls
// ---------------------------------------------------------------------------

// Minimal ESTree shapes we use. Rollup exposes a full typed AST via
// `this.parse`; we only care about a few node kinds.
interface AstNodeBase {
	type: string;
	start: number;
	end: number;
}
interface IdentifierNode extends AstNodeBase {
	type: "Identifier";
	name: string;
}
interface ObjectExpressionNode extends AstNodeBase {
	type: "ObjectExpression";
	properties: AstNodeBase[];
}
interface CallExpressionNode extends AstNodeBase {
	type: "CallExpression";
	callee: AstNodeBase;
	arguments: AstNodeBase[];
}
interface VariableDeclaratorNode extends AstNodeBase {
	type: "VariableDeclarator";
	id: AstNodeBase;
	init: AstNodeBase | null;
}
interface VariableDeclarationNode extends AstNodeBase {
	type: "VariableDeclaration";
	kind: "var" | "let" | "const";
	declarations: VariableDeclaratorNode[];
}
interface ExportNamedDeclarationNode extends AstNodeBase {
	type: "ExportNamedDeclaration";
	declaration: AstNodeBase | null;
}

// Fast-path gate: only parse files that plausibly contain factory calls.
function sourceMightContainActionCall(code: string): boolean {
	return code.includes("action(");
}
function sourceMightContainFactoryCall(code: string): boolean {
	return (
		code.includes("action(") ||
		code.includes("httpTrigger(") ||
		code.includes("cronTrigger(")
	);
}

interface InjectResult {
	code: string;
	map: ReturnType<InstanceType<typeof MagicString>["generateMap"]>;
}

interface PropertyNode extends AstNodeBase {
	type: "Property";
	key: AstNodeBase;
	value: AstNodeBase;
	shorthand?: boolean;
	computed?: boolean;
}

// Return the `<factory>({...})` call expression and the exported identifier
// for a single top-level statement, when the factory callee matches
// `factoryName` and the export is the canonical `export const X = f({...})`.
function matchFactoryExport(
	top: AstNodeBase,
	factoryNames: readonly string[],
): { id: IdentifierNode; call: CallExpressionNode; factory: string } | null {
	if (top.type !== "ExportNamedDeclaration") {
		return null;
	}
	const decl = (top as ExportNamedDeclarationNode).declaration;
	if (!decl || decl.type !== "VariableDeclaration") {
		return null;
	}
	const varDecl = decl as VariableDeclarationNode;
	if (varDecl.kind !== "const" || varDecl.declarations.length !== 1) {
		return null;
	}
	const declarator = varDecl.declarations[0];
	if (!declarator || declarator.id.type !== "Identifier") {
		return null;
	}
	const init = declarator.init;
	if (!init || init.type !== "CallExpression") {
		return null;
	}
	const call = init as CallExpressionNode;
	if (call.callee.type !== "Identifier") {
		return null;
	}
	const name = (call.callee as IdentifierNode).name;
	if (!factoryNames.includes(name)) {
		return null;
	}
	const arg0 = call.arguments[0];
	if (!arg0 || arg0.type !== "ObjectExpression") {
		return null;
	}
	return {
		id: declarator.id as IdentifierNode,
		call,
		factory: name,
	};
}

function matchActionExport(
	top: AstNodeBase,
): { id: IdentifierNode; call: CallExpressionNode } | null {
	const match = matchFactoryExport(top, ["action"]);
	return match ? { id: match.id, call: match.call } : null;
}

function injectNameIntoCall(
	magic: MagicString,
	call: CallExpressionNode,
	idName: string,
): void {
	const obj = call.arguments[0] as ObjectExpressionNode;
	// Insert `name: "<id>"` just before the closing `}` of the object
	// literal. `obj.end` is the position AFTER the closing `}`, so we
	// insert at `end - 1`. Prefix with `, ` when the object already has
	// properties.
	const insertPos = obj.end - 1;
	const sep = obj.properties.length === 0 ? "" : ", ";
	magic.appendLeft(insertPos, `${sep}name: ${JSON.stringify(idName)}`);
}

function injectActionNames(
	code: string,
	parse: (src: string) => unknown,
): InjectResult | null {
	if (!sourceMightContainActionCall(code)) {
		return null;
	}
	const ast = parse(code) as { body: AstNodeBase[] };
	const magic = new MagicString(code);
	let changed = false;
	for (const top of ast.body) {
		const match = matchActionExport(top);
		if (match) {
			injectNameIntoCall(magic, match.call, match.id.name);
			changed = true;
		}
	}
	if (!changed) {
		return null;
	}
	return {
		code: magic.toString(),
		map: magic.generateMap({ hires: true }),
	};
}

// Vite/Rollup plugin that AST-transforms the workflow's source file during
// the per-workflow sub-build. Only the workflow file itself is transformed;
// transitive imports are unaffected (the `One workflow per file` rule keeps
// action declarations in the workflow file).
function actionNameInjectionPlugin(workflowPath: string): Plugin {
	return {
		name: "workflow-engine:inject-action-names",
		enforce: "post",
		transform(code, id) {
			if (id !== workflowPath) {
				return null;
			}
			return injectActionNames(code, (src) => this.parse(src));
		},
	};
}

// ---------------------------------------------------------------------------
// Runtime-only AST transform: strip zod-bearing factory-config properties
// ---------------------------------------------------------------------------

// Properties that are harvested at manifest-build time and don't need to
// survive into the runtime bundle. All three are zod schemas today, so
// stripping them is what lets vite tree-shake the zod package out of the
// owner bundle. The vite plugin composes the full JSON Schemas for the
// manifest host-side.
const ZOD_PROPERTY_NAMES: readonly string[] = [
	"input",
	"output",
	"body",
	"responseBody",
];

function propertyKeyName(prop: PropertyNode): string | null {
	if (prop.type !== "Property") {
		return null;
	}
	const key = prop.key as IdentifierNode & { value?: string; name?: string };
	if (key.type === "Identifier") {
		return key.name ?? null;
	}
	if (key.type === "Literal") {
		return typeof key.value === "string" ? key.value : null;
	}
	return null;
}

const TRAILING_WS_OR_COMMA = /[\s,]/;

function stripZodPropertiesFromCall(
	magic: MagicString,
	call: CallExpressionNode,
	code: string,
): boolean {
	const obj = call.arguments[0] as ObjectExpressionNode;
	let changed = false;
	const props = obj.properties as PropertyNode[];
	for (let i = 0; i < props.length; i++) {
		const prop = props[i];
		if (!prop) {
			continue;
		}
		const name = propertyKeyName(prop);
		if (name === null) {
			continue;
		}
		if (!ZOD_PROPERTY_NAMES.includes(name)) {
			continue;
		}
		// Remove from start of this property to start of next property (or
		// to the end of the last property, trimming the trailing comma if any).
		let removeEnd = prop.end;
		const next = props[i + 1];
		if (next) {
			removeEnd = next.start;
		} else {
			// Last property — also swallow any trailing comma before the `}`.
			let scan = prop.end;
			while (
				scan < obj.end - 1 &&
				TRAILING_WS_OR_COMMA.test(code[scan] ?? "")
			) {
				scan++;
			}
			removeEnd = scan;
		}
		magic.remove(prop.start, removeEnd);
		changed = true;
	}
	return changed;
}

function stripZodFactoryProperties(
	code: string,
	parse: (src: string) => unknown,
): InjectResult | null {
	if (!sourceMightContainFactoryCall(code)) {
		return null;
	}
	const ast = parse(code) as { body: AstNodeBase[] };
	const magic = new MagicString(code);
	let changed = false;
	for (const top of ast.body) {
		const match = matchFactoryExport(top, [
			"action",
			"httpTrigger",
			"cronTrigger",
		]);
		if (!match) {
			continue;
		}
		if (stripZodPropertiesFromCall(magic, match.call, code)) {
			changed = true;
		}
	}
	if (!changed) {
		return null;
	}
	return {
		code: magic.toString(),
		map: magic.generateMap({ hires: true }),
	};
}

function zodStripTransformPlugin(workflowPath: string): Plugin {
	return {
		name: "workflow-engine:strip-zod-factory-properties",
		enforce: "post",
		transform(code, id) {
			if (id !== workflowPath) {
				return null;
			}
			return stripZodFactoryProperties(code, (src) => this.parse(src));
		},
	};
}

// ---------------------------------------------------------------------------
// Workflow bundling
// ---------------------------------------------------------------------------
//
// Two Vite sub-builds per workflow file:
//   1. "manifest" — keeps the original factory config properties so zod
//      schemas are constructed at bundle load. The plugin VM-evaluates the
//      bundle, reads `.input`/`.output`/`.body`/`.responseBody` off the
//      branded exports, and converts them via `.toJSONSchema()` for the
//      manifest. This bundle is discarded after extraction; it never ships.
//   2. "runtime" — applies `zodStripTransformPlugin` to remove the zod-
//      bearing properties from factory calls. Nothing in the resulting IIFE
//      references zod (not from factory args, not from SDK internals since
//      httpTrigger/cronTrigger no longer compose zod schemas at bundle
//      load), so vite tree-shakes the zod package out. This is the bundle
//      shipped to the sandbox.

interface BuildOptions {
	plugins: Plugin[];
}

async function buildWorkflowIife(
	workflowPath: string,
	root: string,
	options: BuildOptions,
): Promise<string> {
	const result = await build({
		configFile: false,
		logLevel: "silent",
		root,
		plugins: options.plugins,
		build: {
			write: false,
			minify: false,
			ssr: true,
			rollupOptions: {
				input: workflowPath,
				output: {
					format: "iife",
					name: IIFE_NAMESPACE,
				},
			},
		},
		ssr: {
			target: "node",
			noExternal: true,
		},
	});

	const output = Array.isArray(result) ? result[0] : result;
	if (!(output && "output" in output)) {
		throw new Error(`Unexpected build result for workflow "${workflowPath}"`);
	}
	const chunk = output.output.find(
		(item) => item.type === "chunk" && item.isEntry,
	);
	if (!chunk || chunk.type !== "chunk") {
		throw new Error(
			`No entry chunk in build output for workflow "${workflowPath}"`,
		);
	}
	return chunk.code;
}

function bundleWorkflowForManifest(
	workflowPath: string,
	root: string,
): Promise<string> {
	return buildWorkflowIife(workflowPath, root, {
		plugins: [actionNameInjectionPlugin(workflowPath)],
	});
}

function bundleWorkflowForRuntime(
	workflowPath: string,
	root: string,
): Promise<string> {
	return buildWorkflowIife(workflowPath, root, {
		plugins: [
			actionNameInjectionPlugin(workflowPath),
			zodStripTransformPlugin(workflowPath),
		],
	});
}

export type { WorkflowPluginOptions };
export { injectActionNames, typecheckWorkflows, workflowPlugin };
