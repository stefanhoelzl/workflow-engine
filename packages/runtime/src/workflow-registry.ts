import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	type HttpTriggerManifest,
	type Manifest,
	ManifestSchema,
	type WorkflowManifest,
} from "@workflow-engine/core";
import { extract as tarExtract } from "tar-stream";
import type {
	HttpTriggerDescriptor,
	TriggerDescriptor,
} from "./executor/types.js";
import type { Logger } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";
import type { TriggerSource, TriggerViewEntry } from "./triggers/source.js";

// ---------------------------------------------------------------------------
// Workflow registry (multi-tenant, metadata-only)
// ---------------------------------------------------------------------------
//
// The registry owns tenant manifests, their bundle sources, and the
// derived list of trigger descriptors. It does NOT own sandboxes
// (see `sandbox-store.ts`) or perform HTTP URL routing (the HTTP
// TriggerSource does, via `reconfigure(view)` pushes from this registry).
//
// Consumers:
//   - TriggerSource plugins: receive `reconfigure(kindFilteredView)` on
//     every state change. Sources build their own kind-specific indexes
//     (URL-pattern map for HTTP, schedule set for cron, etc.).
//   - Executor: receives `(tenant, workflow, descriptor, input, bundleSource)`
//     from a source and runs the invocation.
//   - UI (dashboard / trigger): `list(tenant?)` / `tenants()` for presentation.

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
// Descriptor construction (manifest entry -> TriggerDescriptor)
// ---------------------------------------------------------------------------

function buildHttpDescriptor(
	entry: HttpTriggerManifest,
): HttpTriggerDescriptor {
	const descriptor: HttpTriggerDescriptor = {
		kind: "http",
		type: "http",
		name: entry.name,
		path: entry.path,
		method: entry.method,
		params: [...entry.params],
		body: entry.body as Record<string, unknown>,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
	if (entry.query) {
		return { ...descriptor, query: entry.query as Record<string, unknown> };
	}
	return descriptor;
}

function buildDescriptors(workflow: WorkflowManifest): TriggerDescriptor[] {
	return workflow.triggers.map((entry) => {
		if (entry.type === "http") {
			return buildHttpDescriptor(entry);
		}
		// Future kinds plug in here. The discriminator keeps TS honest.
		throw new Error(
			`unsupported trigger type: ${(entry as { type: string }).type}`,
		);
	});
}

// ---------------------------------------------------------------------------
// Tenant state
// ---------------------------------------------------------------------------

interface TenantState {
	readonly workflows: Map<string, WorkflowManifest>;
	readonly bundleSources: Map<string, string>;
	readonly descriptors: Map<string, TriggerDescriptor[]>;
}

function buildTenantState(
	manifest: Manifest,
	files: Map<string, string>,
): TenantState {
	const workflows = new Map<string, WorkflowManifest>();
	const bundleSources = new Map<string, string>();
	const descriptors = new Map<string, TriggerDescriptor[]>();
	for (const wf of manifest.workflows) {
		const bundleSource = files.get(wf.module);
		if (bundleSource === undefined) {
			continue;
		}
		workflows.set(wf.name, wf);
		bundleSources.set(wf.name, bundleSource);
		descriptors.set(wf.name, buildDescriptors(wf));
	}
	return { workflows, bundleSources, descriptors };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface WorkflowRegistryOptions {
	readonly logger: Logger;
	readonly storageBackend?: StorageBackend;
	// TriggerSource plugins. On every workflow-state mutation the registry
	// calls `source.reconfigure(kindFilteredView)` synchronously. The registry
	// does NOT manage source lifecycle (start/stop); the caller (main.ts) owns
	// that.
	readonly sources?: readonly TriggerSource[];
}

interface RegisterTenantOptions {
	readonly tarballBytes?: Uint8Array;
}

interface WorkflowEntry {
	readonly tenant: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly triggers: readonly TriggerDescriptor[];
}

interface WorkflowRegistry {
	readonly size: number;
	tenants(): string[];
	list(tenant?: string): WorkflowEntry[];
	registerTenant(
		tenant: string,
		files: Map<string, string>,
		opts?: RegisterTenantOptions,
	): Promise<RegisterResult>;
	recover(): Promise<void>;
	dispose(): void;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure composes registry state, manifest parsing, tenant swap, and reconfigure-push to sources — grouping is intentional
function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	const tenantStates = new Map<string, TenantState>();
	const backend = options.storageBackend;
	const sources: readonly TriggerSource[] = options.sources ?? [];

	options.logger.info("workflow-registry.created");

	function collectEntries(): WorkflowEntry[] {
		const entries: WorkflowEntry[] = [];
		for (const [tenant, state] of tenantStates) {
			for (const [name, workflow] of state.workflows) {
				const bundleSource = state.bundleSources.get(name);
				const descriptors = state.descriptors.get(name);
				if (bundleSource === undefined || descriptors === undefined) {
					continue;
				}
				entries.push({ tenant, workflow, bundleSource, triggers: descriptors });
			}
		}
		return entries;
	}

	function notifySources(): void {
		// Partition all active triggers by kind, then hand each source its
		// kind-filtered slice. Sources are responsible for replacing their
		// internal index atomically on reconfigure.
		const entries = collectEntries();
		const byKind = new Map<string, TriggerViewEntry[]>();
		for (const entry of entries) {
			for (const descriptor of entry.triggers) {
				const slice = byKind.get(descriptor.kind) ?? [];
				slice.push({
					tenant: entry.tenant,
					workflow: entry.workflow,
					bundleSource: entry.bundleSource,
					descriptor,
				});
				byKind.set(descriptor.kind, slice);
			}
		}
		for (const source of sources) {
			source.reconfigure(
				(byKind.get(source.kind) ?? []) as TriggerViewEntry<string>[],
			);
		}
	}

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
		notifySources();
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

	function list(tenant?: string): WorkflowEntry[] {
		const entries = collectEntries();
		if (tenant === undefined) {
			return entries;
		}
		return entries.filter((e) => e.tenant === tenant);
	}

	return {
		get size(): number {
			let total = 0;
			for (const state of tenantStates.values()) {
				for (const descriptors of state.descriptors.values()) {
					total += descriptors.length;
				}
			}
			return total;
		},
		tenants() {
			return Array.from(tenantStates.keys());
		},
		list,
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
	RegisterResult,
	RegisterTenantOptions,
	WorkflowEntry,
	WorkflowRegistry,
	WorkflowRegistryOptions,
};
export { createWorkflowRegistry, extractTenantTarGz };
