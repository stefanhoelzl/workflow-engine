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
	isWorkflow,
	type Workflow,
} from "../index.js";

// URL-safe trigger-export-name regex. Matches a JS identifier (no `$`),
// length-capped at 63 to mirror the tenant regex. Enforced at manifest
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

	// Assemble the tenant tarball:
	//   dist/bundle.tar.gz
	//     manifest.json   ({ workflows: [...] })
	//     <name>.js       (one per workflow)
	const tenantManifest = { workflows: built.map((b) => b.manifest) };
	const manifestJson = `${JSON.stringify(tenantManifest, null, 2)}\n`;

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
		`Tenant bundle: ${built.length} workflow(s) packed to ${tarGzPath}`,
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

	const bundleSource = await bundleWorkflow(workflowPath, root);

	// Evaluate the IIFE bundle in a Node vm context to discover branded
	// exports. The bundle assigns its exports to `globalThis[IIFE_NAMESPACE]`
	// of the sandbox context, so we read that global from the context after
	// script execution — no temp file needed.
	const mod = runIifeInVmContext(bundleSource, filestem, ctx);
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
	const sandboxGlobal: Record<string, unknown> = {};
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

type ManifestTriggerEntry = ManifestHttpTriggerEntry | ManifestCronTriggerEntry;

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
	httpTriggerEntries: [string, HttpTrigger][];
	cronTriggerEntries: [string, CronTrigger][];
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
		}
	}
	return {
		workflowEntries,
		actionEntries,
		httpTriggerEntries,
		cronTriggerEntries,
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
	assertZodSchema(trigger.body, bodyLabel, workflowName, ctx);
	const inputSchemaLabel = `trigger "${exportName}".inputSchema`;
	assertZodSchema(trigger.inputSchema, inputSchemaLabel, workflowName, ctx);
	const outputSchemaLabel = `trigger "${exportName}".outputSchema`;
	assertZodSchema(trigger.outputSchema, outputSchemaLabel, workflowName, ctx);
	return {
		name: exportName,
		type: "http",
		method: trigger.method,
		body: toJsonSchema(trigger.body, bodyLabel, workflowName, ctx),
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
	const inputSchemaLabel = `cron trigger "${exportName}".inputSchema`;
	assertZodSchema(trigger.inputSchema, inputSchemaLabel, workflowName, ctx);
	const outputSchemaLabel = `cron trigger "${exportName}".outputSchema`;
	assertZodSchema(trigger.outputSchema, outputSchemaLabel, workflowName, ctx);
	return {
		name: exportName,
		type: "cron",
		schedule: trigger.schedule,
		tz: trigger.tz,
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
	} = discoverExports(mod, filestem, ctx);

	if (workflowEntries.length > 1) {
		ctx.error(
			`Workflow "${filestem}": at most one defineWorkflow per file (found ${String(workflowEntries.length)})`,
		);
	}

	const workflow = workflowEntries[0]?.[1];
	const name = workflow?.name ?? filestem;
	const env: Record<string, string> = workflow ? { ...workflow.env } : {};

	const actions = buildActionEntries(actionEntries, name, ctx);
	const triggers: ManifestTriggerEntry[] = [
		...httpTriggerEntries.map(([k, v]) => buildTriggerEntry(k, v, name, ctx)),
		...cronTriggerEntries.map(([k, v]) =>
			buildCronTriggerEntry(k, v, name, ctx),
		),
	];

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

// Fast-path gate: only parse files that plausibly contain `action(...)` calls.
function sourceMightContainActionCall(code: string): boolean {
	return code.includes("action(");
}

interface InjectResult {
	code: string;
	map: ReturnType<InstanceType<typeof MagicString>["generateMap"]>;
}

// Return the `action({...})` call expression and the exported identifier
// for a single top-level statement, or null if it doesn't match the
// canonical `export const X = action({...})` shape the transform supports.
function matchActionExport(
	top: AstNodeBase,
): { id: IdentifierNode; call: CallExpressionNode } | null {
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
	if (
		call.callee.type !== "Identifier" ||
		(call.callee as IdentifierNode).name !== "action"
	) {
		return null;
	}
	const arg0 = call.arguments[0];
	if (!arg0 || arg0.type !== "ObjectExpression") {
		return null;
	}
	return { id: declarator.id as IdentifierNode, call };
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
// Workflow bundling (one Vite build per workflow)
// ---------------------------------------------------------------------------

async function bundleWorkflow(
	workflowPath: string,
	root: string,
): Promise<string> {
	const result = await build({
		configFile: false,
		logLevel: "silent",
		root,
		plugins: [actionNameInjectionPlugin(workflowPath)],
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

export type { WorkflowPluginOptions };
export { injectActionNames, typecheckWorkflows, workflowPlugin };
