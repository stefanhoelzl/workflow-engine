import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { IIFE_NAMESPACE, TRIGGER_NAME_RE } from "@workflow-engine/core";
import MagicString from "magic-string";
import ts from "typescript";
import { build, type Plugin } from "vite";
import {
	type Action,
	type CronTrigger,
	type HttpTrigger,
	type ImapTrigger,
	isAction,
	isCronTrigger,
	isHttpTrigger,
	isImapTrigger,
	isManualTrigger,
	isWorkflow,
	type ManualTrigger,
	type Workflow,
} from "../index.js";

interface BuildContext {
	error(message: string): never;
}

class BuildWorkflowsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BuildWorkflowsError";
	}
}

const buildContext: BuildContext = {
	error(message: string): never {
		throw new BuildWorkflowsError(message);
	},
};

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
		throw new BuildWorkflowsError(
			`TypeScript errors in workflows:\n${formatted}`,
		);
	}
}

function discoverWorkflowFiles(root: string): string[] {
	const workflows: string[] = [];
	const srcDir = join(root, "src");
	let entries: string[];
	try {
		entries = readdirSync(srcDir);
	} catch {
		return workflows;
	}
	for (const entry of entries) {
		if (
			entry.endsWith(".ts") &&
			!entry.endsWith(".test.ts") &&
			!entry.endsWith(".d.ts")
		) {
			const full = join(srcDir, entry);
			if (statSync(full).isFile()) {
				workflows.push(`./src/${entry}`);
			}
		}
	}
	return workflows;
}

interface BuildWorkflowsOptions {
	cwd: string;
	// Optional explicit list of workflow paths (relative to cwd). When omitted,
	// `buildWorkflows` discovers `src/*.ts` (excluding tests + .d.ts).
	workflows?: string[];
	// Test-only: skip the build-time TypeScript typecheck. Fixture workflows
	// in unit tests are not part of a full tsconfig and would produce noisy
	// lib-resolution errors otherwise. Production callers (CLI) MUST NOT set
	// this flag.
	skipTypecheck?: boolean;
	// Override the env visible to the IIFE-eval VM context. When omitted,
	// `runIifeInVmContext` falls back to `process.env` (the CLI's behaviour
	// for `wfe upload`). The e2e test framework passes a hermetic
	// `describe.buildEnv` so fixture builds don't leak the runner's env.
	env?: Record<string, string>;
}

interface UnsealedWorkflowManifest {
	name: string;
	module: string;
	sha: string;
	env: Record<string, string>;
	// Names of env bindings declared with `env({secret: true})`. The CLI
	// fetches the server public key at upload, seals each value from its
	// own `process.env[name]`, writes `manifest.secrets` + `secretsKeyId`,
	// and DELETES `secretBindings` before POSTing.
	secretBindings?: string[];
	actions: ManifestActionEntry[];
	triggers: ManifestTriggerEntry[];
}

interface UnsealedManifest {
	workflows: UnsealedWorkflowManifest[];
}

interface BuildWorkflowsResult {
	files: Map<string, string>;
	manifest: UnsealedManifest;
}

/**
 * Pure, in-memory workflow build. Discovers workflows under `<cwd>/src/`
 * (or uses `opts.workflows` when given), runs Vite/Rolldown sub-builds for
 * each, evaluates the IIFE in a Node `vm` context to harvest manifest
 * metadata, and returns `{ files, manifest }`.
 *
 * Writes nothing to disk. Callers (`wfe build`, `bundle()`) handle their
 * own emit. The `manifest` is unsealed: any workflow that declares
 * `env({secret: true})` carries `secretBindings` for the CLI to seal at
 * upload time.
 */
async function buildWorkflows(
	opts: BuildWorkflowsOptions,
): Promise<BuildWorkflowsResult> {
	const root = opts.cwd;
	const workflows = opts.workflows ?? discoverWorkflowFiles(root);
	if (workflows.length === 0) {
		throw new BuildWorkflowsError(`no workflows found in ${join(root, "src")}`);
	}

	if (!opts.skipTypecheck) {
		typecheckWorkflows(workflows, root);
	}

	const built = await Promise.all(
		workflows.map((wf) => {
			const workflowPath = resolve(root, wf);
			const filestem = basename(wf, ".ts");
			return buildOneWorkflow({
				workflowPath,
				filestem,
				root,
				...(opts.env === undefined ? {} : { env: opts.env }),
			});
		}),
	);

	const manifest: UnsealedManifest = {
		workflows: built.map((b) => b.manifest),
	};
	const files = new Map<string, string>();
	for (const b of built) {
		files.set(`${b.manifest.name}.js`, b.bundleSource);
	}
	return { files, manifest };
}

interface BuildOneWorkflowArgs {
	workflowPath: string;
	filestem: string;
	root: string;
	env?: Record<string, string>;
}

interface BuiltWorkflow {
	manifest: UnsealedWorkflowManifest;
	bundleSource: string;
}

async function buildOneWorkflow(
	args: BuildOneWorkflowArgs,
): Promise<BuiltWorkflow> {
	const { workflowPath, filestem, root, env } = args;

	// Pass 1 — manifest build, zod inlined. The VM reads the branded
	// exports' zod-bearing config properties so the plugin can emit JSON
	// Schemas into the manifest. This bundle is discarded.
	const manifestSource = await bundleWorkflowForManifest(workflowPath, root);
	const mod = runIifeInVmContext(manifestSource, filestem, env);

	// Pass 2 — runtime build, factory configs stripped of `input`/`output`/
	// `body`/`responseBody`. Zod tree-shakes out. This bundle is what ships
	// to the sandbox, and its sha goes into the manifest.
	const bundleSource = await bundleWorkflowForRuntime(workflowPath, root);
	const sha = createHash("sha256").update(bundleSource).digest("hex");
	const manifest = buildManifestFromMod(mod, filestem, sha);

	return { manifest, bundleSource };
}

function runIifeInVmContext(
	bundleSource: string,
	filestem: string,
	envOverride?: Record<string, string>,
): Record<string, unknown> {
	// The IIFE bundle is a script that declares `var <IIFE_NAMESPACE> = (...)(...)`.
	// Running it via vm.createContext()/vm.runInContext() gives the script a
	// dedicated global object that we can inspect (and discard) afterwards.
	//
	// Branded objects still work across contexts because the SDK uses
	// `Symbol.for(...)` for its brand keys, which are shared between all
	// V8 contexts in the same process.
	//
	// Inject the host's `process.env` so workflow authors can reference real
	// env vars at build time (e.g. `env({ name: "API_URL" })`). Callers can
	// pass `envOverride` for hermetic builds (the e2e test framework does this
	// so a fixture sees only the describe-declared `buildEnv`, not the
	// runner's PATH/HOME/etc).
	const sandboxGlobal: Record<string, unknown> = {
		// biome-ignore lint/style/noProcessEnv: build-time wiring; workflow authors deliberately reference host env vars via env()
		process: { env: envOverride ?? process.env },
	};
	const context = createContext(sandboxGlobal);
	try {
		runInContext(bundleSource, context, { filename: `${filestem}.js` });
	} catch (error: unknown) {
		buildContext.error(
			`Failed to evaluate bundled workflow "${filestem}": ${errorMessage(error)}`,
		);
	}
	const ns = sandboxGlobal[IIFE_NAMESPACE];
	if (typeof ns !== "object" || ns === null) {
		buildContext.error(
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

interface ManifestImapTriggerEntry {
	name: string;
	type: "imap";
	host: string;
	port: number;
	tls: "required" | "starttls" | "none";
	insecureSkipVerify: boolean;
	user: string;
	password: string;
	folder: string;
	search: string;
	onError: { command?: string[] };
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
}

type ManifestTriggerEntry =
	| ManifestHttpTriggerEntry
	| ManifestCronTriggerEntry
	| ManifestManualTriggerEntry
	| ManifestImapTriggerEntry;

interface DiscoveredExports {
	workflowEntries: [string, Workflow][];
	actionEntries: [string, Action][];
	httpTriggerEntries: [string, HttpTrigger][];
	cronTriggerEntries: [string, CronTrigger][];
	imapTriggerEntries: [string, ImapTrigger][];
	manualTriggerEntries: [string, ManualTrigger][];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear if/else chain dispatching by trigger brand — each branch is a simple isX(value) → push; refactoring into a registry would obscure the per-kind discovery contract
function discoverExports(
	mod: Record<string, unknown>,
	filestem: string,
): DiscoveredExports {
	const workflowEntries: [string, Workflow][] = [];
	const actionEntries: [string, Action][] = [];
	const httpTriggerEntries: [string, HttpTrigger][] = [];
	const cronTriggerEntries: [string, CronTrigger][] = [];
	const manualTriggerEntries: [string, ManualTrigger][] = [];
	const imapTriggerEntries: [string, ImapTrigger][] = [];
	for (const [exportName, value] of Object.entries(mod)) {
		if (exportName === "default" && isAction(value)) {
			buildContext.error(
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
		} else if (isImapTrigger(value)) {
			imapTriggerEntries.push([exportName, value]);
		}
	}
	return {
		workflowEntries,
		actionEntries,
		httpTriggerEntries,
		cronTriggerEntries,
		manualTriggerEntries,
		imapTriggerEntries,
	};
}

function buildActionEntries(
	entries: [string, Action][],
	workflowName: string,
): ManifestActionEntry[] {
	const exportNamesByAction = new Map<Action, string[]>();
	for (const [exportName, actionObj] of entries) {
		const list = exportNamesByAction.get(actionObj) ?? [];
		list.push(exportName);
		exportNamesByAction.set(actionObj, list);
	}
	for (const names of exportNamesByAction.values()) {
		if (names.length > 1) {
			buildContext.error(
				`Workflow "${workflowName}": action exported under multiple names ("${names[0]}" and "${names[1]}"); action identity is the export name`,
			);
		}
	}

	const actions: ManifestActionEntry[] = [];
	for (const [exportName, actionObj] of entries) {
		if (actionObj.name === "") {
			buildContext.error(
				`Workflow "${workflowName}": action "${exportName}" was not transformed at build time. Actions must be declared as: export const ${exportName} = action({...})`,
			);
		}
		if (actionObj.name !== exportName) {
			buildContext.error(
				`Workflow "${workflowName}": action "${exportName}" was built-time named "${actionObj.name}"; the name must match the export name`,
			);
		}
		const inputLabel = `action "${exportName}".input`;
		const outputLabel = `action "${exportName}".output`;
		assertZodSchema(actionObj.input, inputLabel, workflowName);
		assertZodSchema(actionObj.output, outputLabel, workflowName);
		actions.push({
			name: exportName,
			input: toJsonSchema(actionObj.input, inputLabel, workflowName),
			output: toJsonSchema(actionObj.output, outputLabel, workflowName),
		});
	}
	return actions;
}

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

function imapAddressJsonSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			name: { type: "string" },
			address: { type: "string" },
		},
		required: ["address"],
		additionalProperties: false,
	};
}

function imapInputJsonSchema(): Record<string, unknown> {
	return {
		$schema: JSON_SCHEMA_DRAFT,
		type: "object",
		properties: {
			uid: { type: "number" },
			messageId: { type: "string" },
			inReplyTo: { type: "string" },
			references: { type: "array", items: { type: "string" } },
			from: imapAddressJsonSchema(),
			to: { type: "array", items: imapAddressJsonSchema() },
			cc: { type: "array", items: imapAddressJsonSchema() },
			bcc: { type: "array", items: imapAddressJsonSchema() },
			replyTo: { type: "array", items: imapAddressJsonSchema() },
			subject: { type: "string" },
			date: { type: "string" },
			text: { type: "string" },
			html: { type: "string" },
			headers: {
				type: "object",
				additionalProperties: { type: "array", items: { type: "string" } },
			},
			attachments: {
				type: "array",
				items: {
					type: "object",
					properties: {
						filename: { type: "string" },
						contentType: { type: "string" },
						size: { type: "number" },
						contentId: { type: "string" },
						contentDisposition: {
							type: "string",
							enum: ["inline", "attachment"],
						},
						content: { type: "string" },
					},
					required: ["contentType", "size", "content"],
					additionalProperties: false,
				},
			},
		},
		required: [
			"uid",
			"references",
			"from",
			"to",
			"cc",
			"bcc",
			"subject",
			"date",
			"headers",
			"attachments",
		],
		additionalProperties: false,
	};
}

function imapOutputJsonSchema(): Record<string, unknown> {
	return {
		$schema: JSON_SCHEMA_DRAFT,
		type: "object",
		properties: {
			command: { type: "array", items: { type: "string" } },
		},
		additionalProperties: false,
	};
}

// Zod emits `{type: "unknown"}` for z.unknown() in some configurations; mirror
// the historical "body:{}" form for the unbodied HTTP case.
function bodyJsonSchemaOrEmpty(
	body: unknown,
	label: string,
	workflowName: string,
): Record<string, unknown> {
	if (body === undefined) {
		return {};
	}
	assertZodSchema(body, label, workflowName);
	return toJsonSchema(body, label, workflowName);
}

function buildTriggerEntry(
	exportName: string,
	trigger: HttpTrigger,
	workflowName: string,
): ManifestHttpTriggerEntry {
	if (typeof trigger !== "function") {
		buildContext.error(
			`Workflow "${workflowName}": trigger "${exportName}" is missing a handler function`,
		);
	}
	if (!TRIGGER_NAME_RE.test(exportName)) {
		buildContext.error(
			`Workflow "${workflowName}": trigger export name "${exportName}" must match ${TRIGGER_NAME_RE}`,
		);
	}
	const bodyLabel = `trigger "${exportName}".body`;
	const bodyJson = bodyJsonSchemaOrEmpty(trigger.body, bodyLabel, workflowName);
	const responseBodyLabel = `trigger "${exportName}".responseBody`;
	let responseBodyJson: Record<string, unknown> | undefined;
	if (trigger.responseBody !== undefined) {
		assertZodSchema(trigger.responseBody, responseBodyLabel, workflowName);
		responseBodyJson = toJsonSchema(
			trigger.responseBody,
			responseBodyLabel,
			workflowName,
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
): ManifestCronTriggerEntry {
	if (typeof trigger !== "function") {
		buildContext.error(
			`Workflow "${workflowName}": cron trigger "${exportName}" is missing a handler function`,
		);
	}
	if (typeof trigger.schedule !== "string" || trigger.schedule === "") {
		buildContext.error(
			`Workflow "${workflowName}": cron trigger "${exportName}" has no schedule`,
		);
	}
	if (typeof trigger.tz !== "string" || trigger.tz === "") {
		buildContext.error(
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

function buildImapTriggerEntry(
	exportName: string,
	trigger: ImapTrigger,
	workflowName: string,
): ManifestImapTriggerEntry {
	if (typeof trigger !== "function") {
		buildContext.error(
			`Workflow "${workflowName}": imap trigger "${exportName}" is missing a handler function`,
		);
	}
	if (!TRIGGER_NAME_RE.test(exportName)) {
		buildContext.error(
			`Workflow "${workflowName}": imap trigger export name "${exportName}" must match ${TRIGGER_NAME_RE}`,
		);
	}
	const onError: { command?: string[] } =
		trigger.onError && Array.isArray(trigger.onError.command)
			? { command: [...trigger.onError.command] }
			: {};
	return {
		name: exportName,
		type: "imap",
		host: trigger.host,
		port: trigger.port,
		tls: trigger.tls,
		insecureSkipVerify: trigger.insecureSkipVerify,
		user: trigger.user,
		password: trigger.password,
		folder: trigger.folder,
		search: trigger.search,
		onError,
		inputSchema: imapInputJsonSchema(),
		outputSchema: imapOutputJsonSchema(),
	};
}

function buildManualTriggerEntry(
	exportName: string,
	trigger: ManualTrigger,
	workflowName: string,
): ManifestManualTriggerEntry {
	if (typeof trigger !== "function") {
		buildContext.error(
			`Workflow "${workflowName}": manual trigger "${exportName}" is missing a handler function`,
		);
	}
	if (!TRIGGER_NAME_RE.test(exportName)) {
		buildContext.error(
			`Workflow "${workflowName}": manual trigger export name "${exportName}" must match ${TRIGGER_NAME_RE}`,
		);
	}
	const inputSchemaLabel = `manual trigger "${exportName}".inputSchema`;
	assertZodSchema(trigger.inputSchema, inputSchemaLabel, workflowName);
	const outputSchemaLabel = `manual trigger "${exportName}".outputSchema`;
	assertZodSchema(trigger.outputSchema, outputSchemaLabel, workflowName);
	return {
		name: exportName,
		type: "manual",
		inputSchema: toJsonSchema(
			trigger.inputSchema,
			inputSchemaLabel,
			workflowName,
		),
		outputSchema: toJsonSchema(
			trigger.outputSchema,
			outputSchemaLabel,
			workflowName,
		),
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: manifest assembly threads discovery → validation → per-kind entry builders; each step is already a named helper
function buildManifestFromMod(
	mod: Record<string, unknown>,
	filestem: string,
	sha: string,
): UnsealedWorkflowManifest {
	const {
		workflowEntries,
		actionEntries,
		httpTriggerEntries,
		cronTriggerEntries,
		manualTriggerEntries,
		imapTriggerEntries,
	} = discoverExports(mod, filestem);

	if (workflowEntries.length > 1) {
		buildContext.error(
			`Workflow "${filestem}": at most one defineWorkflow per file (found ${String(workflowEntries.length)})`,
		);
	}

	const workflow = workflowEntries[0]?.[1];
	const name = workflow?.name || filestem;

	const secretBindingsSymbol = Symbol.for(
		"@workflow-engine/workflow-secret-bindings",
	);
	const secretBindings = workflow
		? ((workflow as unknown as Record<symbol, unknown>)[secretBindingsSymbol] as
				| readonly string[]
				| undefined)
		: undefined;

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

	const actions = buildActionEntries(actionEntries, name);
	const triggers: ManifestTriggerEntry[] = [
		...httpTriggerEntries.map(([k, v]) => buildTriggerEntry(k, v, name)),
		...cronTriggerEntries.map(([k, v]) => buildCronTriggerEntry(k, v, name)),
		...manualTriggerEntries.map(([k, v]) =>
			buildManualTriggerEntry(k, v, name),
		),
		...imapTriggerEntries.map(([k, v]) => buildImapTriggerEntry(k, v, name)),
	];

	const built: UnsealedWorkflowManifest = {
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
): void {
	if (!isZodLike(value)) {
		buildContext.error(
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
): Record<string, unknown> {
	const candidate = schema as ZodLikeWithJsonSchema;
	if (typeof candidate.toJSONSchema !== "function") {
		buildContext.error(
			`Workflow "${workflowName}": ${label} does not support toJSONSchema() (expected Zod v4)`,
		);
	}
	const result = candidate.toJSONSchema();
	if (typeof result !== "object" || result === null) {
		buildContext.error(
			`Workflow "${workflowName}": ${label} toJSONSchema() returned non-object`,
		);
	}
	return result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AST transform: inject `name: "<exportName>"` into `action({...})` calls
// ---------------------------------------------------------------------------

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
		let removeEnd = prop.end;
		const next = props[i + 1];
		if (next) {
			removeEnd = next.start;
		} else {
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

export type {
	BuildWorkflowsOptions,
	BuildWorkflowsResult,
	ManifestActionEntry,
	ManifestCronTriggerEntry,
	ManifestHttpTriggerEntry,
	ManifestManualTriggerEntry,
	ManifestTriggerEntry,
	UnsealedManifest,
	UnsealedWorkflowManifest,
};
export {
	BuildWorkflowsError,
	buildWorkflows,
	injectActionNames,
	typecheckWorkflows,
};
