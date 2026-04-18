import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	type Manifest,
	ManifestSchema,
	type WorkflowManifest,
} from "@workflow-engine/core";
import Ajv2020 from "ajv/dist/2020.js";
import { extract as tarExtract } from "tar-stream";
import type { Logger } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";
import type {
	PayloadValidator,
	ValidationIssue,
	ValidatorResult,
} from "./triggers/http.js";

// ---------------------------------------------------------------------------
// Workflow registry (multi-tenant, metadata-only)
// ---------------------------------------------------------------------------
//
// The registry owns tenant manifests, their bundle sources, and a per-tenant
// HTTP-trigger index. It does NOT own sandboxes (see `sandbox-store.ts`) or
// runners (removed in the sandbox-store change). Consumers:
//   - Executor: calls `registry.lookup(tenant, method, path)` to get routing
//     info; resolves sandbox via the store.
//   - UI (dashboard / trigger): calls `registry.tenants()` / `registry.list()`
//     for presentation.

const ajv = new Ajv2020.default({ allErrors: true, strict: false });

function structuredCloneJson<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

function ajvPathToSegments(instancePath: string): (string | number)[] {
	if (instancePath === "") {
		return [];
	}
	return instancePath
		.split("/")
		.slice(1)
		.map((seg) => {
			const n = Number(seg);
			return Number.isFinite(n) && seg !== "" ? n : seg;
		});
}

function compileValidator(
	schema: unknown,
): (value: unknown) => ValidatorResult<unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: Ajv's compile signature uses a broad generic
	const validate = ajv.compile(schema as any);
	return (value: unknown) => {
		const copy = structuredCloneJson(value);
		const ok = validate(copy);
		if (ok) {
			return { ok: true, value: copy };
		}
		const issues: ValidationIssue[] = (validate.errors ?? []).map((err) => ({
			path: ajvPathToSegments(err.instancePath),
			message: err.message ?? "validation failed",
		}));
		return { ok: false, issues };
	};
}

// ---------------------------------------------------------------------------
// Tenant tarball extraction
// ---------------------------------------------------------------------------

async function extractTenantTarGz(
	buffer: ArrayBuffer | Uint8Array,
): Promise<Map<string, string>> {
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
	const input =
		buffer instanceof Uint8Array ? Buffer.from(buffer) : Buffer.from(buffer);
	await pipeline(Readable.from(input), createGunzip(), extractor);
	return files;
}

// ---------------------------------------------------------------------------
// Trigger payload validator (body / query / params)
// ---------------------------------------------------------------------------

function buildValidatorFromManifestTrigger(
	manifestEntry: WorkflowManifest["triggers"][number],
): PayloadValidator {
	const validateBody = compileValidator(manifestEntry.body);
	const validateParams = compileValidator({
		type: "object",
		properties: Object.fromEntries(
			manifestEntry.params.map((p) => [p, { type: "string" }]),
		),
		required: manifestEntry.params,
		additionalProperties: true,
	});
	const validateQuery = manifestEntry.query
		? compileValidator(manifestEntry.query)
		: (value: unknown): ValidatorResult<unknown> => ({ ok: true, value });
	return { validateBody, validateQuery, validateParams };
}

// ---------------------------------------------------------------------------
// Trigger index (per tenant + per workflow)
// ---------------------------------------------------------------------------

const PARAM_SEGMENT_RE = /[:*]/;
const WILDCARD_SEGMENT_RE = /\*(\w+)/g;

function toUrlPatternPath(path: string): string {
	return path.replace(WILDCARD_SEGMENT_RE, ":$1+");
}

interface TriggerIndexEntry {
	readonly workflow: WorkflowManifest;
	readonly triggerName: string;
	readonly method: string;
	readonly path: string;
	readonly schema: Record<string, unknown>;
	readonly validator: PayloadValidator;
	readonly pattern: URLPattern;
	readonly isStatic: boolean;
}

interface TriggerMatch {
	readonly workflow: WorkflowManifest;
	readonly triggerName: string;
	readonly validator: PayloadValidator;
	readonly params: Record<string, string>;
}

function buildTriggerIndexEntries(
	workflow: WorkflowManifest,
): TriggerIndexEntry[] {
	return workflow.triggers.map((trigger) => ({
		workflow,
		triggerName: trigger.name,
		method: trigger.method,
		path: trigger.path,
		schema: trigger.schema as Record<string, unknown>,
		validator: buildValidatorFromManifestTrigger(trigger),
		pattern: new URLPattern({ pathname: `/${toUrlPatternPath(trigger.path)}` }),
		isStatic: !PARAM_SEGMENT_RE.test(trigger.path),
	}));
}

function extractParams(
	groups: Record<string, string | undefined>,
): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(groups)) {
		if (value !== undefined) {
			params[key] = value;
		}
	}
	return params;
}

function tryMatch(
	entry: TriggerIndexEntry,
	pathname: string,
	method: string,
	isStatic: boolean,
): TriggerMatch | undefined {
	if (entry.isStatic !== isStatic) {
		return;
	}
	if (entry.method !== method) {
		return;
	}
	const result = entry.pattern.exec({ pathname });
	if (!result) {
		return;
	}
	return {
		workflow: entry.workflow,
		triggerName: entry.triggerName,
		validator: entry.validator,
		params: extractParams(
			result.pathname.groups as Record<string, string | undefined>,
		),
	};
}

// ---------------------------------------------------------------------------
// Tenant state
// ---------------------------------------------------------------------------

interface TenantState {
	readonly workflows: Map<string, WorkflowManifest>;
	readonly bundleSources: Map<string, string>;
	readonly triggerEntries: TriggerIndexEntry[];
}

function buildTenantState(
	manifest: Manifest,
	files: Map<string, string>,
): TenantState {
	const workflows = new Map<string, WorkflowManifest>();
	const bundleSources = new Map<string, string>();
	const triggerEntries: TriggerIndexEntry[] = [];
	for (const wf of manifest.workflows) {
		const bundleSource = files.get(wf.module);
		if (bundleSource === undefined) {
			continue;
		}
		workflows.set(wf.name, wf);
		bundleSources.set(wf.name, bundleSource);
		triggerEntries.push(...buildTriggerIndexEntries(wf));
	}
	return { workflows, bundleSources, triggerEntries };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface WorkflowRegistryOptions {
	readonly logger: Logger;
	readonly storageBackend?: StorageBackend;
}

interface RegisterTenantOptions {
	readonly tarballBytes?: Uint8Array;
}

interface WorkflowEntry {
	readonly tenant: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly triggers: readonly TriggerEntry[];
}

interface TriggerEntry {
	readonly triggerName: string;
	readonly method: string;
	readonly path: string;
	readonly schema: Record<string, unknown>;
}

interface LookupResult {
	readonly workflow: WorkflowManifest;
	readonly triggerName: string;
	readonly validator: PayloadValidator;
	readonly params: Record<string, string>;
	readonly bundleSource: string;
}

interface WorkflowRegistry {
	readonly size: number;
	tenants(): string[];
	list(tenant?: string): WorkflowEntry[];
	lookup(
		tenant: string,
		workflowName: string,
		path: string,
		method: string,
	): LookupResult | undefined;
	registerTenant(
		tenant: string,
		files: Map<string, string>,
		opts?: RegisterTenantOptions,
	): Promise<RegisterResult>;
	recover(): Promise<void>;
	dispose(): void;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure composes registry state (per-tenant maps, trigger index) and the suite of operations (register, recover, lookup, list, dispose) with their shared helpers
function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	const tenantStates = new Map<string, TenantState>();
	const backend = options.storageBackend;

	options.logger.info("workflow-registry.created");

	function parseManifest(
		tenant: string,
		manifestRaw: string,
	): { ok: true; manifest: Manifest } | { ok: false; result: RegisterResult } {
		try {
			const parsed: unknown = JSON.parse(manifestRaw);
			const manifest = ManifestSchema.parse(parsed);
			return { ok: true, manifest };
		} catch (err) {
			const shape = toRegisterIssue(err);
			options.logger.warn("workflow-registry.register-failed", {
				tenant,
				...shape,
			});
			return { ok: false, result: { ok: false, ...shape } };
		}
	}

	function validateModulesPresent(
		tenant: string,
		manifest: Manifest,
		files: Map<string, string>,
	): RegisterResult | undefined {
		for (const wf of manifest.workflows) {
			if (!files.has(wf.module)) {
				const error = `missing workflow module: ${wf.module}`;
				options.logger.warn("workflow-registry.register-failed", {
					tenant,
					workflow: wf.name,
					error,
				});
				return { ok: false, error };
			}
		}
	}

	async function persistTarball(
		tenant: string,
		bytes: Uint8Array,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!backend) {
			return { ok: true };
		}
		const finalKey = `workflows/${tenant}.tar.gz`;
		const tempKey = `${finalKey}.upload-${crypto.randomUUID()}`;
		try {
			await backend.writeBytes(tempKey, bytes);
			await backend.move(tempKey, finalKey);
			return { ok: true };
		} catch (err) {
			try {
				await backend.remove(tempKey);
			} catch {
				// best-effort cleanup
			}
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async function registerTenant(
		tenant: string,
		files: Map<string, string>,
		opts?: RegisterTenantOptions,
	): Promise<RegisterResult> {
		const manifestRaw = files.get("manifest.json");
		if (manifestRaw === undefined) {
			options.logger.warn("workflow-registry.register-failed", {
				tenant,
				error: "missing manifest.json",
			});
			return { ok: false, error: "missing manifest.json" };
		}
		const parseResult = parseManifest(tenant, manifestRaw);
		if (!parseResult.ok) {
			return parseResult.result;
		}
		const { manifest } = parseResult;
		const modulesCheck = validateModulesPresent(tenant, manifest, files);
		if (modulesCheck) {
			return modulesCheck;
		}
		if (opts?.tarballBytes && backend) {
			const persisted = await persistTarball(tenant, opts.tarballBytes);
			if (!persisted.ok) {
				const error = `failed to persist tenant bundle: ${persisted.error}`;
				options.logger.error("workflow-registry.persist-failed", {
					tenant,
					error,
				});
				return { ok: false, error };
			}
		}
		tenantStates.set(tenant, buildTenantState(manifest, files));
		options.logger.info("workflow-registry.registered", {
			tenant,
			workflows: manifest.workflows.length,
		});
		return {
			ok: true,
			tenant,
			workflows: manifest.workflows.map((w) => w.name),
		};
	}

	async function recoverOne(
		tenantBackend: StorageBackend,
		key: string,
	): Promise<void> {
		const tenant = key.slice(
			"workflows/".length,
			key.length - ".tar.gz".length,
		);
		try {
			const bytes = await tenantBackend.readBytes(key);
			const files = await extractTenantTarGz(bytes);
			const result = await registerTenant(tenant, files);
			if (!result.ok) {
				options.logger.error("workflow-registry.recover-failed", {
					tenant,
					error: result.error,
				});
			}
		} catch (err) {
			options.logger.error("workflow-registry.recover-failed", {
				tenant,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async function recover(): Promise<void> {
		if (!backend) {
			return;
		}
		for await (const key of backend.list("workflows/")) {
			if (!key.endsWith(".tar.gz")) {
				continue;
			}
			await recoverOne(backend, key);
		}
	}

	function triggerEntriesFor(
		tenant: string,
		workflowName: string,
	): TriggerIndexEntry[] {
		const state = tenantStates.get(tenant);
		if (!state) {
			return [];
		}
		return state.triggerEntries.filter((e) => e.workflow.name === workflowName);
	}

	function lookup(
		tenant: string,
		workflowName: string,
		path: string,
		method: string,
	): LookupResult | undefined {
		const entries = triggerEntriesFor(tenant, workflowName);
		if (entries.length === 0) {
			return;
		}
		const pathname = `/${path}`;
		const bundleSource = tenantStates
			.get(tenant)
			?.bundleSources.get(workflowName);
		if (bundleSource === undefined) {
			return;
		}
		const findMatch = (isStatic: boolean): TriggerMatch | undefined => {
			for (const entry of entries) {
				const match = tryMatch(entry, pathname, method, isStatic);
				if (match) {
					return match;
				}
			}
		};
		const match = findMatch(true) ?? findMatch(false);
		if (!match) {
			return;
		}
		return {
			workflow: match.workflow,
			triggerName: match.triggerName,
			validator: match.validator,
			params: match.params,
			bundleSource,
		};
	}

	function list(tenant?: string): WorkflowEntry[] {
		const entries: WorkflowEntry[] = [];
		const appendTenant = (t: string, state: TenantState) => {
			for (const [name, workflow] of state.workflows) {
				const bundleSource = state.bundleSources.get(name);
				if (bundleSource === undefined) {
					continue;
				}
				const triggers = state.triggerEntries
					.filter((e) => e.workflow.name === name)
					.map(
						(e): TriggerEntry => ({
							triggerName: e.triggerName,
							method: e.method,
							path: e.path,
							schema: e.schema,
						}),
					);
				entries.push({ tenant: t, workflow, bundleSource, triggers });
			}
		};
		if (tenant === undefined) {
			for (const [t, state] of tenantStates) {
				appendTenant(t, state);
			}
		} else {
			const state = tenantStates.get(tenant);
			if (state) {
				appendTenant(tenant, state);
			}
		}
		return entries;
	}

	return {
		get size(): number {
			let total = 0;
			for (const state of tenantStates.values()) {
				total += state.triggerEntries.length;
			}
			return total;
		},
		tenants() {
			return Array.from(tenantStates.keys());
		},
		list,
		lookup,
		registerTenant,
		recover,
		dispose() {
			tenantStates.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Upload result
// ---------------------------------------------------------------------------

interface ManifestIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

type RegisterResult =
	| { ok: true; tenant: string; workflows: string[] }
	| { ok: false; error: string; issues?: ManifestIssue[] };

function normalizeIssue(raw: unknown): ManifestIssue | undefined {
	if (typeof raw !== "object" || raw === null) {
		return;
	}
	const rec = raw as Record<string, unknown>;
	const path = Array.isArray(rec.path)
		? (rec.path as unknown[]).filter(
				(p): p is string | number =>
					typeof p === "string" || typeof p === "number",
			)
		: [];
	const message = typeof rec.message === "string" ? rec.message : "";
	return { path, message };
}

function toRegisterIssue(err: unknown): {
	error: string;
	issues?: ManifestIssue[];
} {
	if (err && typeof err === "object" && "issues" in err) {
		const zodIssues = (err as { issues: unknown[] }).issues;
		const issues: ManifestIssue[] = [];
		for (const raw of zodIssues) {
			const normalized = normalizeIssue(raw);
			if (normalized) {
				issues.push(normalized);
			}
		}
		const message = err instanceof Error ? err.message : "validation failed";
		return {
			error: `invalid manifest: ${message}`,
			issues,
		};
	}
	return {
		error: `invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
	};
}

export type {
	LookupResult,
	ManifestIssue,
	RegisterResult,
	TriggerEntry,
	WorkflowEntry,
	WorkflowRegistry,
	WorkflowRegistryOptions,
};
export { createWorkflowRegistry, extractTenantTarGz };
