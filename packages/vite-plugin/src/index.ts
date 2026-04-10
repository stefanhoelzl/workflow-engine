import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import ts from "typescript";
import type { Plugin, ResolvedConfig } from "vite";

interface WorkflowPluginOptions {
	workflows: string[];
}

interface CompileOutput {
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
	module: string;
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
			const entryChunks = Object.values(bundle).filter(
				(chunk): chunk is typeof chunk & { type: "chunk" } =>
					chunk.type === "chunk" && chunk.isEntry,
			);

			for (const chunk of entryChunks) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential processing for error reporting
				await processEntryChunk(chunk, this);
			}
		},
	};
}

async function processEntryChunk(
	chunk: { name: string; code: string; exports: string[]; fileName: string },
	ctx: PluginContext & { emitFile(file: { type: "asset"; fileName: string; source: string }): void },
): Promise<void> {
	const name = chunk.name;
	const tmpFile = join(tmpdir(), `wf-${name}-${Date.now()}.mjs`);

	await writeFile(tmpFile, chunk.code);
	let mod: Record<string, unknown>;
	try {
		mod = (await import(tmpFile)) as Record<string, unknown>;
	} catch (error) {
		ctx.error(`Failed to import workflow "${name}": ${error instanceof Error ? error.message : String(error)}`);
	}

	const { manifest, actionSources } = extractManifest(mod, name, chunk.code, chunk.exports, ctx);

	ctx.emitFile({
		type: "asset",
		fileName: `${name}/manifest.json`,
		source: JSON.stringify(manifest, null, 2),
	});

	// Emit one file per action with default export
	for (const [actionName, source] of Object.entries(actionSources)) {
		ctx.emitFile({
			type: "asset",
			fileName: `${name}/${actionName}.js`,
			source,
		});
	}

	// Empty the original combined actions.js — individual files replace it
	chunk.code = "";
}

// biome-ignore lint/complexity/useMaxParams: all parameters are distinct required inputs
function extractManifest(
	mod: Record<string, unknown>,
	name: string,
	code: string,
	_exports: string[],
	ctx: PluginContext,
): { manifest: object; actionSources: Record<string, string> } {
	const defaultExport = mod.default as { compile?: () => CompileOutput } | undefined;
	if (!defaultExport || typeof defaultExport.compile !== "function") {
		ctx.error(`Workflow "${name}" default export does not have a .compile() method`);
	}

	let compiled: CompileOutput;
	try {
		compiled = defaultExport.compile();
	} catch (error) {
		ctx.error(`Workflow "${name}" .compile() failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const namedExports = Object.entries(mod).filter(([key]) => key !== "default");
	const actions: ManifestAction[] = [];
	const actionSources: Record<string, string> = {};

	for (const action of compiled.actions) {
		const match = namedExports.find(([, fn]) => fn === action.handler);
		if (!match) {
			ctx.error(`Workflow "${name}": action with on="${action.on}" has no matching named export`);
		}

		const [exportName] = match;
		const actionName = action.name ?? exportName;
		actions.push({
			name: actionName,
			module: `./${actionName}.js`,
			on: action.on,
			emits: action.emits,
			env: action.env,
		});

		// Extract handler source and wrap as default export
		const handlerSource = extractHandlerSource(code, exportName);
		actionSources[actionName] = handlerSource
			? `export default ${handlerSource};\n`
			: `export default ${action.handler.toString()};\n`;
	}

	return {
		manifest: {
			events: compiled.events,
			triggers: compiled.triggers,
			actions,
		},
		actionSources,
	};
}

const ACTION_CALL_RE = /var\s+(\w+)\s*=\s*\w+\.action\(\{/g;
const HANDLER_KEY_RE = /handler:\s*/;

function extractHandlerSource(code: string, exportName: string): string | undefined {
	const pattern = new RegExp(ACTION_CALL_RE.source, "g");
	let match: RegExpExecArray | null = pattern.exec(code);

	while (match !== null) {
		const varName = match[1];
		if (varName !== exportName) {
			match = pattern.exec(code);
			continue;
		}

		const afterAction = code.slice(match.index + match[0].length);
		const handlerMatch = HANDLER_KEY_RE.exec(afterAction);
		if (!handlerMatch) {
			match = pattern.exec(code);
			continue;
		}

		const handlerStart = match.index + match[0].length + handlerMatch.index + handlerMatch[0].length;
		const braceStart = code.indexOf("{", handlerStart);
		if (braceStart === -1) {
			match = pattern.exec(code);
			continue;
		}

		const handlerBodyEnd = findMatchingBrace(code, braceStart);
		return code.slice(handlerStart, handlerBodyEnd + 1);
	}

	return;
}

function findMatchingBrace(code: string, openPos: number): number {
	let depth = 0;
	for (let i = openPos; i < code.length; i++) {
		if (code[i] === "{") {
			depth++;
		} else if (code[i] === "}") {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return code.length - 1;
}

export { typecheckWorkflows, workflowPlugin };
export type { WorkflowPluginOptions };
