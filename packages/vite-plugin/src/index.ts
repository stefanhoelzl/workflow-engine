import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { tsImport } from "tsx/esm/api";
import ts from "typescript";
import { build, type Plugin, type ResolvedConfig } from "vite";

interface WorkflowPluginOptions {
	workflows: string[];
}

interface CompileOutput {
	name: string;
	events: Array<{ name: string; schema: object }>;
	triggers: Array<{
		name: string;
		type: string;
		path: string;
		method?: string;
		response?: { status?: number; body?: unknown };
	}>;
	actions: Array<{
		name: string | undefined;
		on: string;
		emits: string[];
		env: Record<string, string>;
		handler: (...args: unknown[]) => Promise<void>;
	}>;
}

interface ManifestAction {
	name: string;
	export: string;
	on: string;
	emits: string[];
	env: Record<string, string>;
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

function workflowPlugin(options: WorkflowPluginOptions): Plugin {
	let resolvedConfig: ResolvedConfig;
	const workflowPaths = new Map<string, string>();

	return {
		name: "workflow-engine",

		configResolved(config) {
			resolvedConfig = config;
			for (const wf of options.workflows) {
				workflowPaths.set(basename(wf, ".ts"), resolve(config.root, wf));
			}
		},

		buildStart() {
			if (!resolvedConfig.build.watch) {
				typecheckWorkflows(options.workflows, resolvedConfig.root);
				// biome-ignore lint/suspicious/noConsole: intentional build output
				console.log("TypeScript check passed");
			}
		},

		config() {
			const entries = Object.fromEntries(
				options.workflows.map((wf) => [basename(wf, ".ts"), wf]),
			);

			return {
				build: {
					outDir: "dist",
					lib: { entry: entries, formats: ["es"] },
					minify: false,
					rollupOptions: {
						output: { entryFileNames: "[name]/actions.js" },
					},
				},
				ssr: {
					target: "node" as const,
					noExternal: true,
				},
			};
		},

		async generateBundle(_options, bundle) {
			const entryChunks = Object.entries(bundle).filter(
				(entry): entry is [string, (typeof entry)[1] & { type: "chunk" }] =>
					entry[1].type === "chunk" && entry[1].isEntry,
			);

			for (const [key, chunk] of entryChunks) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential processing for error reporting
				await processWorkflow(chunk.name, this, resolvedConfig, workflowPaths);
				delete bundle[key];
			}
		},
	};
}

type EmitContext = PluginContext & {
	emitFile(file: {
		type: "asset";
		fileName: string;
		source: string | Uint8Array;
	}): void;
};

async function processWorkflow(
	name: string,
	ctx: EmitContext,
	config: ResolvedConfig,
	workflowPaths: Map<string, string>,
): Promise<void> {
	const workflowPath = workflowPaths.get(name);
	if (!workflowPath) {
		ctx.error(`No workflow path found for "${name}"`);
	}

	const parentUrl = pathToFileURL(`${config.root}/`).href;
	let mod: Record<string, unknown>;
	try {
		mod = (await tsImport(workflowPath, parentUrl)) as Record<string, unknown>;
	} catch (error) {
		ctx.error(
			`Failed to import workflow "${name}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const { manifest, exportMap } = extractManifest(mod, name, ctx);
	const actionSource = await buildWorkflowModule(workflowPath, config.root);

	const manifestJson = JSON.stringify(manifest, null, 2);

	ctx.emitFile({
		type: "asset",
		fileName: `${name}/manifest.json`,
		source: manifestJson,
	});

	ctx.emitFile({
		type: "asset",
		fileName: `${name}/actions.js`,
		source: actionSource,
	});

	const bundleFiles: Record<string, string> = {
		"manifest.json": manifestJson,
		"actions.js": actionSource,
	};
	const bundle = await createTarGzBundle(bundleFiles);
	ctx.emitFile({
		type: "asset",
		fileName: `${name}/bundle.tar.gz`,
		source: bundle,
	});

	// biome-ignore lint/suspicious/noConsole: intentional build output
	console.log(
		`Workflow "${name}": ${Object.keys(exportMap).length} actions bundled`,
	);
}

function extractManifest(
	mod: Record<string, unknown>,
	name: string,
	ctx: PluginContext,
): { manifest: object; exportMap: Record<string, string> } {
	const defaultExport = mod.default as
		| { compile?: () => CompileOutput }
		| undefined;
	if (!defaultExport || typeof defaultExport.compile !== "function") {
		ctx.error(
			`Workflow "${name}" default export does not have a .compile() method`,
		);
	}

	let compiled: CompileOutput;
	try {
		compiled = defaultExport.compile();
	} catch (error) {
		ctx.error(
			`Workflow "${name}" .compile() failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const namedExports = Object.entries(mod).filter(([key]) => key !== "default");
	const actions: ManifestAction[] = [];
	const exportMap: Record<string, string> = {};

	for (const action of compiled.actions) {
		const match = namedExports.find(([, fn]) => fn === action.handler);
		if (!match) {
			ctx.error(
				`Workflow "${name}": action with on="${action.on}" has no matching named export`,
			);
		}

		const [exportName] = match;
		const actionName = action.name ?? exportName;
		actions.push({
			name: actionName,
			export: exportName,
			on: action.on,
			emits: action.emits,
			env: action.env,
		});

		exportMap[actionName] = exportName;
	}

	return {
		manifest: {
			name: compiled.name,
			module: "actions.js",
			events: compiled.events,
			triggers: compiled.triggers,
			actions,
		},
		exportMap,
	};
}

const SDK_STUB = `
const noop = () => {};
const handler = { get: () => selfProxy, apply: () => selfProxy };
const selfProxy = new Proxy(noop, handler);

export const z = selfProxy;
export function http() { return selfProxy; }
export function env() { return ""; }
export function createWorkflow() {
  const b = {
    trigger: () => b,
    event: () => b,
    action: (config) => config.handler,
    compile: noop,
  };
  return b;
}
export const ENV_REF = Symbol("env");
export const ManifestSchema = selfProxy;
`;

async function buildWorkflowModule(
	workflowPath: string,
	root: string,
): Promise<string> {
	const stubId = "\0sdk-stub";
	const sdkPackage = "@workflow-engine/sdk";

	const result = await build({
		configFile: false,
		logLevel: "silent",
		root,
		plugins: [
			{
				name: "sdk-stub",
				enforce: "pre",
				resolveId(id) {
					if (id === sdkPackage) {
						return stubId;
					}
				},
				load(id) {
					if (id === stubId) {
						return SDK_STUB;
					}
				},
			},
		],
		build: {
			write: false,
			minify: false,
			ssr: true,
			rollupOptions: {
				input: workflowPath,
				output: { format: "es" },
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

async function createTarGzBundle(
	files: Record<string, string>,
): Promise<Uint8Array> {
	const packer = tarPack();
	for (const [name, content] of Object.entries(files)) {
		packer.entry({ name }, content);
	}
	packer.finalize();

	const chunks: Buffer[] = [];
	const gzip = createGzip();
	gzip.on("data", (chunk: Buffer) => chunks.push(chunk));

	await pipeline(packer, gzip);
	return Buffer.concat(chunks);
}

export type { WorkflowPluginOptions };
export { typecheckWorkflows, workflowPlugin };
