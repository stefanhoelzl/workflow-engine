import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Plugin } from "vite";

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
		event: string;
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
	handler: string;
	on: string;
	emits: string[];
	env: Record<string, string>;
}

interface PluginContext {
	error(message: string): never;
}

function workflowPlugin(options: WorkflowPluginOptions): Plugin {
	return {
		name: "workflow-engine",

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
	chunk: { name: string; code: string; exports: string[] },
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

	const manifest = extractManifest(mod, name, ctx);
	if (!manifest) {
		return;
	}

	ctx.emitFile({
		type: "asset",
		fileName: `${name}/manifest.json`,
		source: JSON.stringify(manifest, null, 2),
	});

	chunk.code = transformBundledHandlers(chunk.code, chunk.exports);
}

function extractManifest(
	mod: Record<string, unknown>,
	name: string,
	ctx: PluginContext,
): object | undefined {
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

	for (const action of compiled.actions) {
		const match = namedExports.find(([, fn]) => fn === action.handler);
		if (!match) {
			ctx.error(`Workflow "${name}": action with on="${action.on}" has no matching named export`);
		}

		const [exportName] = match;
		actions.push({
			name: action.name ?? exportName,
			handler: exportName,
			on: action.on,
			emits: action.emits,
			env: action.env,
		});
	}

	return {
		events: compiled.events,
		triggers: compiled.triggers,
		actions,
		module: "./actions.js",
	};
}

const ACTION_CALL_RE = /var\s+(\w+)\s*=\s*\w+\.action\(\{/g;
const HANDLER_KEY_RE = /handler:\s*/;

function transformBundledHandlers(code: string, exports: string[]): string {
	// Extract only the handler functions from var X = *.action({...handler: fn...}) patterns
	const handlerExports = exports.filter((e) => e !== "default");
	const handlers: string[] = [];

	const pattern = new RegExp(ACTION_CALL_RE.source, "g");
	let match: RegExpExecArray | null = pattern.exec(code);

	while (match !== null) {
		const varName = match[1];
		if (!handlerExports.includes(varName ?? "")) {
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
		const handlerSource = code.slice(handlerStart, handlerBodyEnd + 1);
		handlers.push(`var ${varName} = ${handlerSource};`);

		match = pattern.exec(code);
	}

	const exportLine = `export { ${handlerExports.join(", ")} };`;
	return `${handlers.join("\n")}\n${exportLine}\n`;
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

export { workflowPlugin };
export type { WorkflowPluginOptions };
