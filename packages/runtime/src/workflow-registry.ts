import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	type CronTriggerManifest,
	type HttpTriggerManifest,
	type ImapTriggerManifest,
	type Manifest,
	ManifestSchema,
	type ManualTriggerManifest,
	type WorkflowManifest,
	type WsTriggerManifest,
	z,
} from "@workflow-engine/core";
import { extract as tarExtract } from "tar-stream";
import { validateOwner, validateRepo } from "./auth/owner.js";
import type { Executor } from "./executor/index.js";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	ImapTriggerDescriptor,
	ManualTriggerDescriptor,
	TriggerDescriptor,
	WsTriggerDescriptor,
} from "./executor/types.js";
import type { Logger } from "./logger.js";
import { decryptWorkflowSecrets } from "./secrets/decrypt-workflow.js";
import type { SecretsKeyStore } from "./secrets/index.js";
import type { StorageBackend } from "./storage/index.js";
import { buildException } from "./triggers/build-exception.js";
import { buildFire } from "./triggers/build-fire.js";
import { resolveSecretSentinels } from "./triggers/resolve-secret-sentinels.js";
import type {
	ReconfigureResult,
	TriggerConfigError,
	TriggerEntry,
	TriggerSource,
} from "./triggers/source.js";

const LEGACY_KEY_RE = /^workflows\/[^/]+\.tar\.gz$/;
const REPO_KEY_RE = /^workflows\/([^/]+)\/([^/]+)\.tar\.gz$/;

// ---------------------------------------------------------------------------
// Workflow registry (multi-(owner, repo), metadata-only)
// ---------------------------------------------------------------------------
//
// The registry owns per-repo manifests, their bundle sources, the derived
// list of trigger descriptors, and the `TriggerEntry` list (descriptor +
// pre-wired `fire` closure) per (owner, repo).
//
// It does NOT own sandboxes (see `sandbox-store.ts`) or perform HTTP URL
// routing (the HTTP TriggerSource does, via `reconfigure(owner, repo,
// entries)` pushes from this registry).
//
// Consumers:
//   - TriggerSource backends: receive `reconfigure(owner, repo, entries)` on
//     every repo upload. Backends build their own per-(owner,repo) indexes
//     (URL patterns for HTTP, timers for cron, etc.).
//   - Executor: invoked exclusively from inside `fire` closures built by
//     this registry — backends never call the executor directly.
//   - UI (dashboard / trigger): `list(owner?, repo?)`, `owners()`,
//     `repos(owner)`, `pairs()`, and `getEntry(owner, repo, workflow,
//     trigger)` for presentation and manual fire.

// ---------------------------------------------------------------------------
// Owner tarball extraction
// ---------------------------------------------------------------------------

const MAX_DECOMPRESSED_BYTES = 10_485_760;

async function extractOwnerTarGz(
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

// Walk a rehydrated zod tree and reconstruct each `ZodObject` whose
// `.meta().strip === true` in default `.strip()` mode. Recovers author
// intent across the lossy zod ↔ JSON Schema round-trip, where
// `additionalProperties: false` collapses both strip-default `.object()`
// and `.strict()` modes into the same JSON Schema and `fromJSONSchema`
// always re-emits as `.strict()`.
//
// .meta() survives the full round-trip natively in zod v4 (toJSONSchema
// flattens custom keys to the schema root; fromJSONSchema reads them back),
// so this walk operates on the rehydrated zod tree alone — no parallel
// JSON Schema walk. See http-trigger spec "Object schema strip-mode marker
// (`strip`)" requirement.
function applyStripMarkers(zod: z.ZodType<unknown>): z.ZodType<unknown> {
	if (!(zod instanceof z.ZodObject)) {
		return zod;
	}
	const oldShape = zod.shape as Record<string, z.ZodType<unknown>>;
	const newShape: Record<string, z.ZodType<unknown>> = {};
	let childrenChanged = false;
	for (const [k, v] of Object.entries(oldShape)) {
		const rebuilt = applyStripMarkers(v);
		if (rebuilt !== v) {
			childrenChanged = true;
		}
		newShape[k] = rebuilt;
	}
	const meta: Record<string, unknown> =
		// biome-ignore lint/suspicious/noExplicitAny: zod v4's .meta() return
		((zod as any).meta?.() as Record<string, unknown> | undefined) ?? {};
	const stripMarked = meta.strip === true;
	if (!(stripMarked || childrenChanged)) {
		return zod;
	}
	// Detect parent catchall to preserve mode when only children changed.
	const catchallType: string | undefined =
		// biome-ignore lint/suspicious/noExplicitAny: zod v4 internal
		(zod as any)._def?.catchall?.def?.type;
	let rebuilt: z.ZodType<unknown>;
	if (stripMarked) {
		rebuilt = z.object(newShape) as z.ZodType<unknown>; // strip default
	} else if (catchallType === "never") {
		rebuilt = z.strictObject(newShape) as z.ZodType<unknown>;
	} else if (catchallType === "any" || catchallType === "unknown") {
		rebuilt = z.object(newShape).loose() as z.ZodType<unknown>;
	} else {
		rebuilt = z.object(newShape) as z.ZodType<unknown>;
	}
	if (Object.keys(meta).length > 0) {
		// biome-ignore lint/suspicious/noExplicitAny: zod v4 .meta() return type
		rebuilt = (rebuilt as any).meta(meta);
	}
	return rebuilt;
}

// Rehydrate a manifest JSON Schema into a Zod schema. Throws with a
// trigger-scoped message when `z.fromJSONSchema` rejects the structure;
// `buildDescriptors` translates the throw into a registration failure.
function rehydrateSchema(
	workflowName: string,
	triggerName: string,
	field: "inputSchema" | "outputSchema" | "body",
	schema: Record<string, unknown>,
): z.ZodType<unknown> {
	try {
		const base = z.fromJSONSchema(schema) as z.ZodType<unknown>;
		return applyStripMarkers(base);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`workflow "${workflowName}" trigger "${triggerName}" ${field}: ` +
				`failed to rehydrate JSON Schema (${reason})`,
		);
	}
}

// Public helper for non-registry callers (the test descriptor helper). Same
// rehydration path the registry uses internally; throws are bare here because
// callers handle their own error context.
function rehydrateSchemaForTests(
	schema: Record<string, unknown>,
): z.ZodType<unknown> {
	const base = z.fromJSONSchema(schema) as z.ZodType<unknown>;
	return applyStripMarkers(base);
}

// Pre-resolution descriptor (before sentinel resolution + Zod attachment).
// Identical shape to `TriggerDescriptor` minus the rehydrated Zod schemas;
// Zod schema objects are non-plain objects whose internals would be mangled
// by `resolveSecretSentinels`'s deep walk, so attach them after sentinels
// have been resolved on the JSON-Schema-only fields.
type PreResolveDescriptor = Omit<
	TriggerDescriptor,
	"zodInputSchema" | "zodOutputSchema"
>;

function buildHttpDescriptor(
	workflowName: string,
	entry: HttpTriggerManifest,
): Omit<HttpTriggerDescriptor, "zodInputSchema" | "zodOutputSchema"> {
	const descriptor: Omit<
		HttpTriggerDescriptor,
		"zodInputSchema" | "zodOutputSchema"
	> = {
		kind: "http",
		type: "http",
		name: entry.name,
		workflowName,
		method: entry.method,
		request: {
			body: entry.request.body as Record<string, unknown>,
			headers: entry.request.headers as Record<string, unknown>,
		},
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
	if (entry.response !== undefined) {
		const response: {
			body?: Record<string, unknown>;
			headers?: Record<string, unknown>;
		} = {};
		if (entry.response.body !== undefined) {
			response.body = entry.response.body as Record<string, unknown>;
		}
		if (entry.response.headers !== undefined) {
			response.headers = entry.response.headers as Record<string, unknown>;
		}
		(descriptor as { response?: typeof response }).response = response;
	}
	return descriptor;
}

function buildCronDescriptor(
	workflowName: string,
	entry: CronTriggerManifest,
): Omit<CronTriggerDescriptor, "zodInputSchema" | "zodOutputSchema"> {
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
): Omit<ManualTriggerDescriptor, "zodInputSchema" | "zodOutputSchema"> {
	return {
		kind: "manual",
		type: "manual",
		name: entry.name,
		workflowName,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
}

function buildWsDescriptor(
	workflowName: string,
	entry: WsTriggerManifest,
): Omit<WsTriggerDescriptor, "zodInputSchema" | "zodOutputSchema"> {
	return {
		kind: "ws",
		type: "ws",
		name: entry.name,
		workflowName,
		request: entry.request as Record<string, unknown>,
		response: entry.response as Record<string, unknown>,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
}

function buildImapDescriptor(
	workflowName: string,
	entry: ImapTriggerManifest,
): Omit<ImapTriggerDescriptor, "zodInputSchema" | "zodOutputSchema"> {
	// `onError.command` is zod-optional (so typed `string[] | undefined`), but
	// `ImapTriggerDescriptor.onError.command` is exactOptional; build the
	// envelope conditionally rather than widening the descriptor type.
	const onError: { readonly command?: readonly string[] } =
		entry.onError.command === undefined
			? {}
			: { command: entry.onError.command };
	return {
		kind: "imap",
		type: "imap",
		name: entry.name,
		workflowName,
		host: entry.host,
		port: entry.port,
		tls: entry.tls,
		insecureSkipVerify: entry.insecureSkipVerify,
		user: entry.user,
		password: entry.password,
		folder: entry.folder,
		search: entry.search,
		mode: entry.mode,
		onError,
		inputSchema: entry.inputSchema as Record<string, unknown>,
		outputSchema: entry.outputSchema as Record<string, unknown>,
	};
}

// Attach pre-rehydrated Zod schemas to a sentinel-resolved descriptor.
// Throws on rehydration failure; the caller catches and surfaces as a
// registration failure. Sentinels never reach JSON-Schema fields (they
// only live in string-typed config fields like cron `schedule`/`tz` or
// imap credentials), so rehydrating from `inputSchema` / `outputSchema`
// after sentinel resolution is safe.
function attachZodSchemas(descriptor: PreResolveDescriptor): TriggerDescriptor {
	const zodInputSchema = rehydrateSchema(
		descriptor.workflowName,
		descriptor.name,
		"inputSchema",
		descriptor.inputSchema,
	);
	const zodOutputSchema = rehydrateSchema(
		descriptor.workflowName,
		descriptor.name,
		"outputSchema",
		descriptor.outputSchema,
	);
	return {
		...descriptor,
		zodInputSchema,
		zodOutputSchema,
	} as TriggerDescriptor;
}

function buildPreResolvedDescriptor(
	workflowName: string,
	entry: WorkflowManifest["triggers"][number],
): PreResolveDescriptor | { error: string } {
	if (entry.type === "http") {
		return buildHttpDescriptor(workflowName, entry);
	}
	if (entry.type === "cron") {
		return buildCronDescriptor(workflowName, entry);
	}
	if (entry.type === "manual") {
		return buildManualDescriptor(workflowName, entry);
	}
	if (entry.type === "imap") {
		return buildImapDescriptor(workflowName, entry);
	}
	if (entry.type === "ws") {
		return buildWsDescriptor(workflowName, entry);
	}
	return {
		error:
			'invalid manifest: unsupported trigger kind "' +
			(entry as { type: string }).type +
			'"',
	};
}

function buildDescriptors(
	workflow: WorkflowManifest,
	allowedKinds: ReadonlySet<string> | undefined,
	keyStore: SecretsKeyStore,
):
	| { ok: true; descriptors: TriggerDescriptor[] }
	| { ok: false; error: string }
	| { ok: false; error: "secret_ref_unresolved"; missing: string[] } {
	// Decrypt sealed secrets once per workflow-load. Plaintext lives for the
	// duration of this function call plus whatever `TriggerSource.reconfigure`
	// retains; see SECURITY.md §5 "Plaintext confinement within engine code".
	const plaintextStore = decryptWorkflowSecrets(workflow, keyStore);
	const missing = new Set<string>();
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
		const built = buildPreResolvedDescriptor(workflow.name, entry);
		if ("error" in built) {
			return { ok: false, error: built.error };
		}
		// Substitute `\x00secret:NAME\x00` sentinel substrings with decrypted
		// plaintext BEFORE attaching Zod schemas. Every `TriggerSource`
		// implementation receives resolved plaintext via `reconfigure`; sources
		// MUST NOT parse sentinels themselves (see SECURITY.md §5).
		const resolved = resolveSecretSentinels(built, plaintextStore, missing);
		// Attach pre-rehydrated Zod schemas AFTER the deep sentinel walk —
		// Zod schemas are non-plain objects whose internals would be mangled
		// by the walker. Rehydration runs once per workflow load, never per
		// fire() invocation (per payload-validation/spec.md).
		try {
			descriptors.push(attachZodSchemas(resolved));
		} catch (err) {
			// Schema rehydration failed for this trigger. Surface as a
			// registration failure so the tenant sees a precise pointer at the
			// offending trigger; `rehydrateSchema` builds the message.
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
	if (missing.size > 0) {
		return {
			ok: false,
			error: "secret_ref_unresolved",
			missing: [...missing].sort(),
		};
	}
	return { ok: true, descriptors };
}

// ---------------------------------------------------------------------------
// Owner/repo state
// ---------------------------------------------------------------------------

interface OwnerRepoState {
	readonly workflows: Map<string, WorkflowManifest>;
	readonly bundleSources: Map<string, string>;
	readonly descriptors: Map<string, TriggerDescriptor[]>;
	// Flat map of `${workflowName}/${triggerName}` -> TriggerEntry, used by
	// the `/trigger` UI manual-fire path and by the list() accessor.
	readonly entries: Map<string, TriggerEntry>;
}

interface BuildStateDeps {
	readonly executor: Executor;
	readonly allowedKinds: ReadonlySet<string> | undefined;
	readonly logger: Logger;
	readonly keyStore: SecretsKeyStore;
}

interface UnresolvedSecretFailure {
	readonly workflow: string;
	readonly missing: readonly string[];
}

// biome-ignore lint/complexity/useMaxParams: orthogonal inputs (owner, repo, manifest, files, deps); packaging would just shuffle the same fields
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: linear pipeline — manifest validation, secret resolution, descriptor build, fire+exception closure construction; splitting fragments the per-workflow loop
function buildOwnerRepoState(
	owner: string,
	repo: string,
	manifest: Manifest,
	files: Map<string, string>,
	deps: BuildStateDeps,
):
	| { ok: true; state: OwnerRepoState }
	| { ok: false; error: string }
	| {
			ok: false;
			error: "secret_ref_unresolved";
			failures: UnresolvedSecretFailure[];
	  } {
	const workflows = new Map<string, WorkflowManifest>();
	const bundleSources = new Map<string, string>();
	const descriptorsByWf = new Map<string, TriggerDescriptor[]>();
	const entries = new Map<string, TriggerEntry>();
	const secretFailures: UnresolvedSecretFailure[] = [];
	for (const wf of manifest.workflows) {
		const bundleSource = files.get(wf.module);
		if (bundleSource === undefined) {
			continue;
		}
		const built = buildDescriptors(wf, deps.allowedKinds, deps.keyStore);
		if (!built.ok) {
			if ("missing" in built) {
				// Accumulate across workflows so the caller can report every
				// broken workflow in a single failure response.
				secretFailures.push({ workflow: wf.name, missing: built.missing });
				continue;
			}
			return { ok: false, error: built.error };
		}
		workflows.set(wf.name, wf);
		bundleSources.set(wf.name, bundleSource);
		descriptorsByWf.set(wf.name, built.descriptors);
		for (const descriptor of built.descriptors) {
			const fire = buildFire(
				deps.executor,
				owner,
				repo,
				wf,
				descriptor,
				bundleSource,
				deps.logger,
			);
			const exception = buildException(
				deps.executor,
				owner,
				repo,
				wf,
				descriptor,
			);
			entries.set(`${wf.name}/${descriptor.name}`, {
				descriptor,
				fire,
				exception,
			});
		}
	}
	if (secretFailures.length > 0) {
		return {
			ok: false,
			error: "secret_ref_unresolved",
			failures: secretFailures,
		};
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
	// Keystore for decrypting `manifest.secrets` at workflow-registration
	// time. The registry uses plaintext to substitute `\x00secret:…\x00`
	// sentinels inside trigger descriptor string fields before dispatching
	// entries to `TriggerSource.reconfigure`. The sandbox store independently
	// re-decrypts at sandbox spawn for handler-body secret access; no cache
	// is shared between the two paths.
	readonly keyStore: SecretsKeyStore;
	readonly storageBackend?: StorageBackend;
	// TriggerSource backends. On every successful repo upload the registry
	// calls `backend.reconfigure(owner, repo, entries)` on every backend in
	// parallel with `Promise.allSettled`. The registry does NOT manage
	// backend lifecycle (start/stop); the caller (main.ts) owns that.
	readonly backends?: readonly TriggerSource[];
}

interface RegisterOwnerOptions {
	readonly tarballBytes?: Uint8Array;
}

interface WorkflowEntry {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly triggers: readonly TriggerDescriptor[];
}

interface OwnerRepoPair {
	readonly owner: string;
	readonly repo: string;
}

interface WorkflowRegistry {
	readonly size: number;
	owners(): string[];
	repos(owner: string): string[];
	pairs(): OwnerRepoPair[];
	list(owner?: string, repo?: string): WorkflowEntry[];
	registerOwner(
		owner: string,
		repo: string,
		files: Map<string, string>,
		opts?: RegisterOwnerOptions,
	): Promise<RegisterResult>;
	recover(): Promise<void>;
	// Resolves a pre-built TriggerEntry for manual-fire via the /trigger UI.
	// Returns undefined if no such trigger exists for this (owner, repo,
	// workflow, triggerName). Input validation happens inside the returned
	// `fire` closure.
	getEntry(
		owner: string,
		repo: string,
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure composes registry state, manifest parsing, (owner, repo) swap, and reconfigure-push to backends — grouping is intentional
function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	// Per-owner map of repo -> state. Outer key is owner so `repos(owner)`
	// and `reconfigure(owner, repo, [])` stay keyed on the natural hierarchy.
	const ownerStates = new Map<string, Map<string, OwnerRepoState>>();
	const backend = options.storageBackend;
	const backends: readonly TriggerSource[] = options.backends ?? [];
	// Only enforce the kind-allowlist when at least one backend is
	// registered. No backends → no constraint (used in unit tests that
	// exercise registry semantics without the dispatch surface).
	const allowedKinds: ReadonlySet<string> | undefined =
		backends.length > 0 ? new Set(backends.map((b) => b.kind)) : undefined;

	options.logger.info("workflow-registry.created");

	function getRepoState(
		owner: string,
		repo: string,
	): OwnerRepoState | undefined {
		return ownerStates.get(owner)?.get(repo);
	}

	function setRepoState(
		owner: string,
		repo: string,
		state: OwnerRepoState,
	): void {
		let repos = ownerStates.get(owner);
		if (!repos) {
			repos = new Map();
			ownerStates.set(owner, repos);
		}
		repos.set(repo, state);
	}

	function collectForRepo(
		owner: string,
		repo: string,
		state: OwnerRepoState,
	): WorkflowEntry[] {
		const out: WorkflowEntry[] = [];
		for (const [name, workflow] of state.workflows) {
			const bundleSource = state.bundleSources.get(name);
			const descriptors = state.descriptors.get(name);
			if (bundleSource === undefined || descriptors === undefined) {
				continue;
			}
			out.push({ owner, repo, workflow, bundleSource, triggers: descriptors });
		}
		return out;
	}

	function collectEntries(
		ownerFilter?: string,
		repoFilter?: string,
	): WorkflowEntry[] {
		const out: WorkflowEntry[] = [];
		for (const [owner, repos] of ownerStates) {
			if (ownerFilter !== undefined && owner !== ownerFilter) {
				continue;
			}
			for (const [repo, state] of repos) {
				if (repoFilter !== undefined && repo !== repoFilter) {
					continue;
				}
				out.push(...collectForRepo(owner, repo, state));
			}
		}
		return out;
	}

	async function reconfigureBackends(
		owner: string,
		repo: string,
		state: OwnerRepoState,
	): Promise<ReconfigureAggregate> {
		// Partition this (owner, repo)'s entries per backend kind. Backends
		// whose kind doesn't appear in the manifest still receive an empty
		// array so stale entries from a previous upload get cleared.
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
					owner,
					repo,
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
		owner: string,
		repo: string,
		manifestRaw: string,
	): { ok: true; manifest: Manifest } | { ok: false; result: RegisterResult } {
		try {
			const parsed: unknown = JSON.parse(manifestRaw);
			const manifest = ManifestSchema.parse(parsed);
			return { ok: true, manifest };
		} catch (err) {
			const shape = toRegisterIssue(err);
			options.logger.warn("workflow-registry.register-failed", {
				owner,
				repo,
				...shape,
			});
			return { ok: false, result: { ok: false, ...shape } };
		}
	}

	function validateModulesPresent(
		owner: string,
		repo: string,
		manifest: Manifest,
		files: Map<string, string>,
	): RegisterResult | undefined {
		for (const wf of manifest.workflows) {
			if (!files.has(wf.module)) {
				const error = `missing workflow module: ${wf.module}`;
				options.logger.warn("workflow-registry.register-failed", {
					owner,
					repo,
					workflow: wf.name,
					error,
				});
				return { ok: false, error };
			}
		}
	}

	async function persistTarball(
		owner: string,
		repo: string,
		bytes: Uint8Array,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!backend) {
			return { ok: true };
		}
		// Write directly to the canonical key. `StorageBackend.write` is
		// contractually atomic (FS: tmp+rename; S3: PutObject), so no staging
		// key is needed. See openspec/specs/storage-backend/spec.md.
		const key = `workflows/${owner}/${repo}.tar.gz`;
		try {
			await backend.write(key, bytes);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	function prepareOwnerRepoState(
		owner: string,
		repo: string,
		files: Map<string, string>,
	):
		| { ok: true; state: OwnerRepoState; workflowCount: number }
		| { ok: false; result: RegisterResult } {
		const manifestRaw = files.get("manifest.json");
		if (manifestRaw === undefined) {
			options.logger.warn("workflow-registry.register-failed", {
				owner,
				repo,
				error: "missing manifest.json",
			});
			return {
				ok: false,
				result: { ok: false, error: "missing manifest.json" },
			};
		}
		const parseResult = parseManifest(owner, repo, manifestRaw);
		if (!parseResult.ok) {
			return { ok: false, result: parseResult.result };
		}
		const { manifest } = parseResult;
		const modulesCheck = validateModulesPresent(owner, repo, manifest, files);
		if (modulesCheck) {
			return { ok: false, result: modulesCheck };
		}
		const built = buildOwnerRepoState(owner, repo, manifest, files, {
			executor: options.executor,
			allowedKinds,
			logger: options.logger,
			keyStore: options.keyStore,
		});
		if (!built.ok) {
			if ("failures" in built) {
				options.logger.warn("workflow-registry.register-failed", {
					owner,
					repo,
					error: "secret_ref_unresolved",
					failures: built.failures,
				});
				return {
					ok: false,
					result: {
						ok: false,
						error: "secret_ref_unresolved",
						secretFailures: built.failures,
					},
				};
			}
			options.logger.warn("workflow-registry.register-failed", {
				owner,
				repo,
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

	async function registerOwner(
		owner: string,
		repo: string,
		files: Map<string, string>,
		opts?: RegisterOwnerOptions,
	): Promise<RegisterResult> {
		const prepared = prepareOwnerRepoState(owner, repo, files);
		if (!prepared.ok) {
			return prepared.result;
		}
		const { state, workflowCount } = prepared;

		const aggregate = await reconfigureBackends(owner, repo, state);
		if (aggregate.kind !== "ok") {
			options.logger.warn("workflow-registry.reconfigure-failed", {
				owner,
				repo,
				kind: aggregate.kind,
			});
			return mapAggregateToResult(aggregate);
		}

		if (opts?.tarballBytes && backend) {
			const persisted = await persistTarball(owner, repo, opts.tarballBytes);
			if (!persisted.ok) {
				const error = `failed to persist workflow bundle: ${persisted.error}`;
				options.logger.error("workflow-registry.persist-failed", {
					owner,
					repo,
					error,
				});
				return { ok: false, error };
			}
		}
		setRepoState(owner, repo, state);
		options.logger.info("workflow-registry.registered", {
			owner,
			repo,
			workflows: workflowCount,
		});
		return {
			ok: true,
			owner,
			repo,
			workflows: Array.from(state.workflows.keys()),
		};
	}

	async function recoverOne(
		storageBackend: StorageBackend,
		key: string,
		owner: string,
		repo: string,
	): Promise<void> {
		try {
			const bytes = await storageBackend.read(key);
			const files = await extractOwnerTarGz(bytes);
			const result = await registerOwner(owner, repo, files);
			if (!result.ok) {
				options.logger.error("workflow-registry.recover-failed", {
					owner,
					repo,
					error: result.error,
				});
			}
		} catch (err) {
			options.logger.error("workflow-registry.recover-failed", {
				owner,
				repo,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	function parseRecoverKey(
		key: string,
	): { owner: string; repo: string } | undefined {
		if (LEGACY_KEY_RE.test(key)) {
			// Pre-repo-dimension layout (`workflows/<owner>.tar.gz`). The deploy
			// runbook wipes these before rollout; warn and skip so the process
			// still recovers whatever is already in the new shape.
			options.logger.warn("workflow-registry.recover-skipped-legacy", { key });
			return;
		}
		const match = REPO_KEY_RE.exec(key);
		if (!match) {
			options.logger.warn("workflow-registry.recover-skipped-unknown", {
				key,
			});
			return;
		}
		const [, owner, repo] = match as unknown as [string, string, string];
		if (!(validateOwner(owner) && validateRepo(repo))) {
			options.logger.warn("workflow-registry.recover-skipped-invalid", {
				key,
				owner,
				repo,
			});
			return;
		}
		return { owner, repo };
	}

	async function recover(): Promise<void> {
		if (!backend) {
			return;
		}
		for await (const key of backend.list("workflows/")) {
			if (!key.endsWith(".tar.gz")) {
				continue;
			}
			const parsed = parseRecoverKey(key);
			if (!parsed) {
				continue;
			}
			await recoverOne(backend, key, parsed.owner, parsed.repo);
		}
	}

	function list(owner?: string, repo?: string): WorkflowEntry[] {
		return collectEntries(owner, repo);
	}

	function getEntry(
		owner: string,
		repo: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry | undefined {
		return getRepoState(owner, repo)?.entries.get(
			`${workflowName}/${triggerName}`,
		);
	}

	return {
		get size(): number {
			let total = 0;
			for (const repos of ownerStates.values()) {
				for (const state of repos.values()) {
					for (const descriptors of state.descriptors.values()) {
						total += descriptors.length;
					}
				}
			}
			return total;
		},
		owners() {
			return Array.from(ownerStates.keys());
		},
		repos(owner: string) {
			const repos = ownerStates.get(owner);
			return repos ? Array.from(repos.keys()) : [];
		},
		pairs() {
			const out: OwnerRepoPair[] = [];
			for (const [owner, repos] of ownerStates) {
				for (const repo of repos.keys()) {
					out.push({ owner, repo });
				}
			}
			return out;
		},
		list,
		registerOwner,
		recover,
		getEntry,
		dispose() {
			ownerStates.clear();
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
	| { ok: true; owner: string; repo: string; workflows: string[] }
	| {
			ok: false;
			error: string;
			issues?: ManifestIssue[];
			userErrors?: readonly TriggerConfigError[];
			infraErrors?: readonly BackendInfraError[];
			// Populated when `error === "secret_ref_unresolved"`: one entry per
			// workflow that referenced a secret name not present in its
			// decrypted `manifest.secrets` store. Surfaces as HTTP 400 in the
			// upload handler.
			secretFailures?: readonly UnresolvedSecretFailure[];
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
	return { ok: true, owner: "", repo: "", workflows: [] };
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
	OwnerRepoPair,
	RegisterOwnerOptions,
	RegisterResult,
	UnresolvedSecretFailure,
	WorkflowEntry,
	WorkflowRegistry,
	WorkflowRegistryOptions,
};
export { createWorkflowRegistry, extractOwnerTarGz, rehydrateSchemaForTests };
