import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	type CronTriggerManifest,
	type HttpTriggerManifest,
	type Manifest,
	ManifestSchema,
	type ManualTriggerManifest,
	type WorkflowManifest,
} from "@workflow-engine/core";
import { extract as tarExtract } from "tar-stream";
import type { Executor } from "./executor/index.js";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	ManualTriggerDescriptor,
	TriggerDescriptor,
} from "./executor/types.js";
import type { Logger } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";
import { buildFire } from "./triggers/build-fire.js";
import type {
	ReconfigureResult,
	TriggerConfigError,
	TriggerEntry,
	TriggerSource,
} from "./triggers/source.js";

// ---------------------------------------------------------------------------
// Workflow registry (multi-tenant, metadata-only)
// ---------------------------------------------------------------------------
//
// The registry owns tenant manifests, their bundle sources, the derived list
// of trigger descriptors, and the `TriggerEntry` list (descriptor + pre-
// wired `fire` closure) per tenant.
//
// It does NOT own sandboxes (see `sandbox-store.ts`) or perform HTTP URL
// routing (the HTTP TriggerSource does, via `reconfigure(tenant, entries)`
// pushes from this registry).
//
// Consumers:
//   - TriggerSource backends: receive `reconfigure(tenant, entries)` on
//     every tenant upload. Backends build their own per-tenant indexes
//     (URL patterns for HTTP, timers for cron, etc.).
//   - Executor: invoked exclusively from inside `fire` closures built by
//     this registry — backends never call the executor directly.
//   - UI (dashboard / trigger): `list(tenant?)`, `tenants()`, and
//     `getEntry(tenant, workflow, trigger)` for presentation and manual
//     fire.

// ---------------------------------------------------------------------------
// Tenant tarball extraction
// ---------------------------------------------------------------------------

const MAX_DECOMPRESSED_BYTES = 10_485_760;

async function extractTenantTarGz(
	buffer: ArrayBuffer | Uint8Array,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const extractor = tarExtract();
	let totalBytes = 0;
	extractor.on("entry", (header, stream, next) => {
		if (header.type === "file") {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => {
				totalBytes += chunk.length;
				if (totalBytes > MAX_DECOMPRESSED_BYTES) {
					stream.destroy(new Error("decompressed tarball exceeds limit"));
					return;
				}
				chunks.push(chunk);
			});
			stream.on("end", () => {
				files.set(header.name, Buffer.concat(chunks).toString("utf-8"));
				next();
			});
			stream.on("error", (err) => next(err));
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
	workflowName: string,
	entry: HttpTriggerManifest,
): HttpTriggerDescriptor {
	return {
		kind: "http",
		type: "http",
		name: entry.name,
		workflowName,
		method: entry.method,
		body: entry.body as Record<string, unknown>,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
}

function buildCronDescriptor(
	workflowName: string,
	entry: CronTriggerManifest,
): CronTriggerDescriptor {
	return {
		kind: "cron",
		type: "cron",
		name: entry.name,
		workflowName,
		schedule: entry.schedule,
		tz: entry.tz,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
}

function buildManualDescriptor(
	workflowName: string,
	entry: ManualTriggerManifest,
): ManualTriggerDescriptor {
	return {
		kind: "manual",
		type: "manual",
		name: entry.name,
		workflowName,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
}

function buildDescriptors(
	workflow: WorkflowManifest,
	allowedKinds: ReadonlySet<string> | undefined,
):
	| { ok: true; descriptors: TriggerDescriptor[] }
	| { ok: false; error: string } {
	const descriptors: TriggerDescriptor[] = [];
	for (const entry of workflow.triggers) {
		if (allowedKinds && !allowedKinds.has(entry.type)) {
			return {
				ok: false,
				error:
					'invalid manifest: unsupported trigger kind "' +
					entry.type +
					'" (workflow "' +
					workflow.name +
					'" trigger "' +
					entry.name +
					'")',
			};
		}
		if (entry.type === "http") {
			descriptors.push(buildHttpDescriptor(workflow.name, entry));
		} else if (entry.type === "cron") {
			descriptors.push(buildCronDescriptor(workflow.name, entry));
		} else if (entry.type === "manual") {
			descriptors.push(buildManualDescriptor(workflow.name, entry));
		} else {
			// Shouldn't happen — allowedKinds is derived from registered backends
			// and the parser's union covers every registered kind. Guard anyway.
			return {
				ok: false,
				error:
					'invalid manifest: unsupported trigger kind "' +
					(entry as { type: string }).type +
					'"',
			};
		}
	}
	return { ok: true, descriptors };
}

// ---------------------------------------------------------------------------
// Tenant state
// ---------------------------------------------------------------------------

interface TenantState {
	readonly workflows: Map<string, WorkflowManifest>;
	readonly bundleSources: Map<string, string>;
	readonly descriptors: Map<string, TriggerDescriptor[]>;
	// Flat map of `${workflowName}/${triggerName}` -> TriggerEntry, used by
	// the `/trigger` UI manual-fire path and by the list() accessor.
	readonly entries: Map<string, TriggerEntry>;
}

// biome-ignore lint/complexity/useMaxParams: orthogonal inputs (tenant, manifest, files, executor, allowedKinds, logger); packaging would just shuffle the same fields
function buildTenantState(
	tenant: string,
	manifest: Manifest,
	files: Map<string, string>,
	executor: Executor,
	allowedKinds: ReadonlySet<string> | undefined,
	logger: Logger,
): { ok: true; state: TenantState } | { ok: false; error: string } {
	const workflows = new Map<string, WorkflowManifest>();
	const bundleSources = new Map<string, string>();
	const descriptorsByWf = new Map<string, TriggerDescriptor[]>();
	const entries = new Map<string, TriggerEntry>();
	for (const wf of manifest.workflows) {
		const bundleSource = files.get(wf.module);
		if (bundleSource === undefined) {
			continue;
		}
		const built = buildDescriptors(wf, allowedKinds);
		if (!built.ok) {
			return { ok: false, error: built.error };
		}
		workflows.set(wf.name, wf);
		bundleSources.set(wf.name, bundleSource);
		descriptorsByWf.set(wf.name, built.descriptors);
		for (const descriptor of built.descriptors) {
			const fire = buildFire(
				executor,
				tenant,
				wf,
				descriptor,
				bundleSource,
				logger,
			);
			entries.set(`${wf.name}/${descriptor.name}`, { descriptor, fire });
		}
	}
	return {
		ok: true,
		state: {
			workflows,
			bundleSources,
			descriptors: descriptorsByWf,
			entries,
		},
	};
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface WorkflowRegistryOptions {
	readonly logger: Logger;
	readonly executor: Executor;
	readonly storageBackend?: StorageBackend;
	// TriggerSource backends. On every successful tenant upload the registry
	// calls `backend.reconfigure(tenant, entries)` on every backend in
	// parallel with `Promise.allSettled`. The registry does NOT manage
	// backend lifecycle (start/stop); the caller (main.ts) owns that.
	readonly backends?: readonly TriggerSource[];
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
	// Resolves a pre-built TriggerEntry for manual-fire via the /trigger UI.
	// Returns undefined if no such trigger exists for this (tenant, workflow,
	// triggerName). Input validation happens inside the returned `fire`
	// closure.
	getEntry(
		tenant: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry | undefined;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Aggregated reconfigure results across all backends
// ---------------------------------------------------------------------------

interface BackendInfraError {
	readonly backend: string;
	readonly message: string;
}

type ReconfigureAggregate =
	| { readonly kind: "ok" }
	| { readonly kind: "user"; readonly errors: readonly TriggerConfigError[] }
	| {
			readonly kind: "infra";
			readonly errors: readonly BackendInfraError[];
	  }
	| {
			readonly kind: "both";
			readonly userErrors: readonly TriggerConfigError[];
			readonly infraErrors: readonly BackendInfraError[];
	  };

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure composes registry state, manifest parsing, tenant swap, and reconfigure-push to backends — grouping is intentional
function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	const tenantStates = new Map<string, TenantState>();
	const backend = options.storageBackend;
	const backends: readonly TriggerSource[] = options.backends ?? [];
	// Only enforce the kind-allowlist when at least one backend is
	// registered. No backends → no constraint (used in unit tests that
	// exercise registry semantics without the dispatch surface).
	const allowedKinds: ReadonlySet<string> | undefined =
		backends.length > 0 ? new Set(backends.map((b) => b.kind)) : undefined;

	options.logger.info("workflow-registry.created");

	function collectEntries(tenant?: string): WorkflowEntry[] {
		const out: WorkflowEntry[] = [];
		const iter = tenant
			? (() => {
					const s = tenantStates.get(tenant);
					return s ? [[tenant, s] as const] : [];
				})()
			: [...tenantStates.entries()];
		for (const [t, state] of iter) {
			for (const [name, workflow] of state.workflows) {
				const bundleSource = state.bundleSources.get(name);
				const descriptors = state.descriptors.get(name);
				if (bundleSource === undefined || descriptors === undefined) {
					continue;
				}
				out.push({
					tenant: t,
					workflow,
					bundleSource,
					triggers: descriptors,
				});
			}
		}
		return out;
	}

	async function reconfigureBackends(
		tenant: string,
		state: TenantState,
	): Promise<ReconfigureAggregate> {
		// Partition this tenant's entries per backend kind. Backends whose
		// kind doesn't appear in the manifest still receive an empty array
		// so stale entries from a previous upload get cleared.
		const entriesByKind = new Map<string, TriggerEntry[]>();
		for (const b of backends) {
			entriesByKind.set(b.kind, []);
		}
		for (const entry of state.entries.values()) {
			const slot = entriesByKind.get(entry.descriptor.kind);
			if (slot) {
				slot.push(entry);
			}
		}

		const settled = await Promise.allSettled(
			backends.map((b) => {
				const entries = entriesByKind.get(b.kind) ?? [];
				// Each backend narrows D to its concrete descriptor type; the
				// registry holds a heterogeneous list so we widen through
				// `unknown`. Backends enforce the per-kind shape via their
				// own typed factories (HttpTriggerSource, CronTriggerSource).
				return b.reconfigure(
					tenant,
					entries as unknown as readonly TriggerEntry[],
				);
			}),
		);

		const userErrors: TriggerConfigError[] = [];
		const infraErrors: BackendInfraError[] = [];
		settled.forEach((res, idx) => {
			const kindName = backends[idx]?.kind ?? "unknown";
			if (res.status === "rejected") {
				const reason = res.reason;
				infraErrors.push({
					backend: kindName,
					message: reason instanceof Error ? reason.message : String(reason),
				});
				return;
			}
			const value = res.value as ReconfigureResult;
			if (!value.ok) {
				for (const err of value.errors) {
					userErrors.push(err);
				}
			}
		});

		if (userErrors.length > 0 && infraErrors.length > 0) {
			return { kind: "both", userErrors, infraErrors };
		}
		if (userErrors.length > 0) {
			return { kind: "user", errors: userErrors };
		}
		if (infraErrors.length > 0) {
			return { kind: "infra", errors: infraErrors };
		}
		return { kind: "ok" };
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
		// Write directly to the canonical key. `StorageBackend.writeBytes` is
		// contractually atomic (FS: tmp+rename; S3: PutObject), so no staging
		// key is needed. See openspec/specs/storage-backend/spec.md.
		const key = `workflows/${tenant}.tar.gz`;
		try {
			await backend.writeBytes(key, bytes);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	function prepareTenantState(
		tenant: string,
		files: Map<string, string>,
	):
		| { ok: true; state: TenantState; workflowCount: number }
		| { ok: false; result: RegisterResult } {
		const manifestRaw = files.get("manifest.json");
		if (manifestRaw === undefined) {
			options.logger.warn("workflow-registry.register-failed", {
				tenant,
				error: "missing manifest.json",
			});
			return {
				ok: false,
				result: { ok: false, error: "missing manifest.json" },
			};
		}
		const parseResult = parseManifest(tenant, manifestRaw);
		if (!parseResult.ok) {
			return { ok: false, result: parseResult.result };
		}
		const { manifest } = parseResult;
		const modulesCheck = validateModulesPresent(tenant, manifest, files);
		if (modulesCheck) {
			return { ok: false, result: modulesCheck };
		}
		const built = buildTenantState(
			tenant,
			manifest,
			files,
			options.executor,
			allowedKinds,
			options.logger,
		);
		if (!built.ok) {
			options.logger.warn("workflow-registry.register-failed", {
				tenant,
				error: built.error,
			});
			return {
				ok: false,
				result: { ok: false, error: built.error },
			};
		}
		return {
			ok: true,
			state: built.state,
			workflowCount: manifest.workflows.length,
		};
	}

	async function registerTenant(
		tenant: string,
		files: Map<string, string>,
		opts?: RegisterTenantOptions,
	): Promise<RegisterResult> {
		const prepared = prepareTenantState(tenant, files);
		if (!prepared.ok) {
			return prepared.result;
		}
		const { state, workflowCount } = prepared;

		const aggregate = await reconfigureBackends(tenant, state);
		if (aggregate.kind !== "ok") {
			options.logger.warn("workflow-registry.reconfigure-failed", {
				tenant,
				kind: aggregate.kind,
			});
			return mapAggregateToResult(aggregate);
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
		tenantStates.set(tenant, state);
		options.logger.info("workflow-registry.registered", {
			tenant,
			workflows: workflowCount,
		});
		return {
			ok: true,
			tenant,
			workflows: Array.from(state.workflows.keys()),
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
		return collectEntries(tenant);
	}

	function getEntry(
		tenant: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry | undefined {
		return tenantStates
			.get(tenant)
			?.entries.get(`${workflowName}/${triggerName}`);
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
		getEntry,
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
	| {
			ok: false;
			error: string;
			issues?: ManifestIssue[];
			userErrors?: readonly TriggerConfigError[];
			infraErrors?: readonly BackendInfraError[];
	  };

function mapAggregateToResult(aggregate: ReconfigureAggregate): RegisterResult {
	if (aggregate.kind === "user") {
		return {
			ok: false,
			error: "trigger_config_failed",
			userErrors: aggregate.errors,
		};
	}
	if (aggregate.kind === "infra") {
		return {
			ok: false,
			error: "trigger_backend_failed",
			infraErrors: aggregate.errors,
		};
	}
	if (aggregate.kind === "both") {
		return {
			ok: false,
			error: "trigger_config_failed",
			userErrors: aggregate.userErrors,
			infraErrors: aggregate.infraErrors,
		};
	}
	// "ok" already handled by caller; defensive fallback.
	return { ok: true, tenant: "", workflows: [] };
}

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
	const message = err instanceof Error ? err.message : String(err);
	return {
		error: `invalid manifest: ${message}`,
	};
}

export type {
	BackendInfraError,
	RegisterResult,
	RegisterTenantOptions,
	WorkflowEntry,
	WorkflowRegistry,
	WorkflowRegistryOptions,
};
export { createWorkflowRegistry, extractTenantTarGz };
