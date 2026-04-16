import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createContext, runInContext } from "node:vm";
import { createGzip } from "node:zlib";
import { iifeName } from "@workflow-engine/core";
import { pack as tarPack } from "tar-stream";
import ts from "typescript";
import { build, type Plugin, type ResolvedConfig } from "vite";
import {
	type Action,
	extractParamNames,
	type HttpTrigger,
	isAction,
	isHttpTrigger,
	isWorkflow,
	type Workflow,
} from "../index.js";

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
	await Promise.all(
		options.workflows.map((wf) => {
			const workflowPath = resolve(resolvedConfig.root, wf);
			const filestem = basename(wf, ".ts");
			return buildOneWorkflow({
				workflowPath,
				filestem,
				outDir,
				root: resolvedConfig.root,
				ctx,
			});
		}),
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
	outDir: string;
	root: string;
	ctx: PluginContext;
}

async function buildOneWorkflow(args: BuildOneWorkflowArgs): Promise<void> {
	const { workflowPath, filestem, outDir, root, ctx } = args;

	const bundleIifeName = iifeName(filestem);
	const bundleSource = await bundleWorkflow(workflowPath, root, bundleIifeName);

	// Evaluate the IIFE bundle in a Node vm context to discover branded
	// exports. The bundle assigns its exports to `globalThis[bundleIifeName]`
	// of the sandbox context, so we read that global from the context after
	// script execution — no temp file needed.
	const mod = runIifeInVmContext(bundleSource, bundleIifeName, filestem, ctx);
	const sha = createHash("sha256").update(bundleSource).digest("hex");
	const manifest = buildManifest(mod, filestem, sha, ctx);

	const outWorkflowDir = join(outDir, manifest.name);
	await mkdir(outWorkflowDir, { recursive: true });
	await writeFile(
		join(outWorkflowDir, `${manifest.name}.js`),
		bundleSource,
		"utf8",
	);
	await writeFile(
		join(outWorkflowDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

	// Pack a .tar.gz containing manifest.json + <name>.js for the upload
	// pipeline (POST /api/workflows). The dev script and CI can POST this
	// file directly instead of tarring at upload time.
	const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
	const tarGzPath = join(outWorkflowDir, "bundle.tar.gz");
	await packTarGz(tarGzPath, [
		{ name: "manifest.json", content: manifestJson },
		{ name: `${manifest.name}.js`, content: bundleSource },
	]);

	// biome-ignore lint/suspicious/noConsole: intentional build output
	console.log(
		`Workflow "${manifest.name}": ${manifest.actions.length} action(s), ${manifest.triggers.length} trigger(s) bundled`,
	);
}

function runIifeInVmContext(
	bundleSource: string,
	iifeName: string,
	filestem: string,
	ctx: PluginContext,
): Record<string, unknown> {
	// The IIFE bundle is a script that declares `var <iifeName> = (...)(...)`.
	// Running it via vm.createContext()/vm.runInContext() gives the script a
	// dedicated global object that we can inspect (and discard) afterwards —
	// `var` bindings bind to that sandbox's global, not this process's.
	//
	// Branded objects still work across contexts because the SDK uses
	// `Symbol.for(...)` for its brand keys, which are shared between all
	// V8 contexts in the same process.
	const sandboxGlobal: Record<string, unknown> = {};
	const context = createContext(sandboxGlobal);
	try {
		runInContext(bundleSource, context, { filename: `${filestem}.js` });
	} catch (error: unknown) {
		ctx.error(
			`Failed to evaluate bundled workflow "${filestem}": ${errorMessage(error)}`,
		);
	}
	const ns = sandboxGlobal[iifeName];
	if (typeof ns !== "object" || ns === null) {
		ctx.error(
			`Bundled workflow "${filestem}": IIFE did not assign exports to globalThis.${iifeName}`,
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
	path: string;
	method: string;
	body: Record<string, unknown>;
	params: string[];
	query?: Record<string, unknown>;
	schema: Record<string, unknown>;
}

type ManifestTriggerEntry = ManifestHttpTriggerEntry;

interface BuiltManifest {
	name: string;
	module: string;
	sha: string;
	env: Record<string, string>;
	actions: ManifestActionEntry[];
	triggers: ManifestTriggerEntry[];
}

interface DiscoveredExports {
	workflowEntries: [string, Workflow][];
	actionEntries: [string, Action][];
	triggerEntries: [string, HttpTrigger][];
}

function discoverExports(mod: Record<string, unknown>): DiscoveredExports {
	const workflowEntries: [string, Workflow][] = [];
	const actionEntries: [string, Action][] = [];
	const triggerEntries: [string, HttpTrigger][] = [];
	for (const [exportName, value] of Object.entries(mod)) {
		if (isWorkflow(value)) {
			workflowEntries.push([exportName, value]);
		} else if (isAction(value)) {
			actionEntries.push([exportName, value]);
		} else if (isHttpTrigger(value)) {
			triggerEntries.push([exportName, value]);
		}
	}
	return { workflowEntries, actionEntries, triggerEntries };
}

function buildActionEntries(
	entries: [string, Action][],
	workflowName: string,
	ctx: PluginContext,
): ManifestActionEntry[] {
	// Detect aliased action exports (same action object under multiple names)
	// and assign each action its export name via __setActionName. That helper
	// is write-once and same-name idempotent (SDK contract), so exporting the
	// same action twice under the same alias is fine; different aliases throw.
	const seenActions = new Map<Action, string>();
	const actions: ManifestActionEntry[] = [];
	for (const [exportName, actionObj] of entries) {
		const previous = seenActions.get(actionObj);
		if (previous !== undefined && previous !== exportName) {
			ctx.error(
				`Workflow "${workflowName}": action exported under multiple names ("${previous}" and "${exportName}"); action identity is the export name`,
			);
		}
		seenActions.set(actionObj, exportName);
		try {
			actionObj.__setActionName(exportName);
		} catch (err) {
			ctx.error(
				`Workflow "${workflowName}": failed to bind action name "${exportName}": ${errorMessage(err)}`,
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

function buildTriggerEntry(
	exportName: string,
	trigger: HttpTrigger,
	workflowName: string,
	ctx: PluginContext,
): ManifestHttpTriggerEntry {
	if (typeof trigger.handler !== "function") {
		ctx.error(
			`Workflow "${workflowName}": trigger "${exportName}" is missing a handler function`,
		);
	}
	const bodyLabel = `trigger "${exportName}".body`;
	assertZodSchema(trigger.body, bodyLabel, workflowName, ctx);
	const schemaLabel = `trigger "${exportName}".schema`;
	assertZodSchema(trigger.schema, schemaLabel, workflowName, ctx);
	const entry: ManifestHttpTriggerEntry = {
		name: exportName,
		type: "http",
		path: trigger.path,
		method: trigger.method,
		body: toJsonSchema(trigger.body, bodyLabel, workflowName, ctx),
		params: extractParamNames(trigger.path),
		schema: toJsonSchema(trigger.schema, schemaLabel, workflowName, ctx),
	};
	// The SDK defaults trigger.query to z.object({}) (an empty object schema)
	// when the author did not supply one; treat that default as "no query"
	// and omit the field from the manifest entry. If the author supplied an
	// explicit empty z.object({}) it becomes indistinguishable — treat both
	// the same way since the runtime doesn't need to validate nothing.
	if (trigger.query !== undefined && !isEmptyObjectSchema(trigger.query)) {
		const queryLabel = `trigger "${exportName}".query`;
		assertZodSchema(trigger.query, queryLabel, workflowName, ctx);
		entry.query = toJsonSchema(trigger.query, queryLabel, workflowName, ctx);
	}
	return entry;
}

function buildManifest(
	mod: Record<string, unknown>,
	filestem: string,
	sha: string,
	ctx: PluginContext,
): BuiltManifest {
	const { workflowEntries, actionEntries, triggerEntries } =
		discoverExports(mod);

	if (workflowEntries.length > 1) {
		ctx.error(
			`Workflow "${filestem}": at most one defineWorkflow per file (found ${String(workflowEntries.length)})`,
		);
	}

	const workflow = workflowEntries[0]?.[1];
	const name = workflow?.name ?? filestem;
	const env: Record<string, string> = workflow ? { ...workflow.env } : {};

	const actions = buildActionEntries(actionEntries, name, ctx);
	const triggers: ManifestTriggerEntry[] = triggerEntries.map(([k, v]) =>
		buildTriggerEntry(k, v, name, ctx),
	);

	return {
		name,
		module: `${name}.js`,
		sha,
		env,
		actions,
		triggers,
	};
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

function isEmptyObjectSchema(schema: unknown): boolean {
	const asRecord = schema as
		| { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } }
		| undefined;
	const def = asRecord?._zod?.def;
	if (def?.type !== "object") {
		return false;
	}
	const shape = def.shape;
	return shape !== undefined && Object.keys(shape).length === 0;
}

// ---------------------------------------------------------------------------
// Workflow bundling (one Vite build per workflow)
// ---------------------------------------------------------------------------

async function bundleWorkflow(
	workflowPath: string,
	root: string,
	iifeName: string,
): Promise<string> {
	const result = await build({
		configFile: false,
		logLevel: "silent",
		root,
		build: {
			write: false,
			minify: false,
			ssr: true,
			rollupOptions: {
				input: workflowPath,
				output: {
					format: "iife",
					name: iifeName,
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

export type { WorkflowPluginOptions };
export { typecheckWorkflows, workflowPlugin };
