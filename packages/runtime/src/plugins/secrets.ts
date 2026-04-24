import type {
	GuestFunctionDescription,
	PluginSetup,
	WorkerToMain,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";

/**
 * workflow-secrets plugin.
 *
 * Responsibilities:
 *   1. Install `globalThis.workflow = Object.freeze({ name, env })` at
 *      guest() time. `env` is the union of plaintext bindings from the
 *      manifest's `env` field AND decrypted plaintexts from
 *      `manifest.secrets`. Both resolve to plain strings in the guest's
 *      `workflow.env.X` — authors see no distinction.
 *   2. Install `globalThis.$secrets = Object.freeze({ addSecret })` as
 *      a locked bridge to the worker-side plaintext scrubber. The SDK's
 *      `secret()` factory calls into this bridge to register runtime-
 *      computed sensitive values.
 *   3. Keep a worker-side `activePlaintexts` list (longest-first) seeded
 *      from `plaintextStore` at plugin construction. `addSecret` grows it.
 *   4. `onPost` walks every outbound `WorkerToMain` message and replaces
 *      any literal occurrence of a known plaintext with `"[secret]"` on
 *      every string leaf.
 *
 * Lifetime of plaintext in memory:
 *   manifest.secrets is stable per (tenant, workflow.sha) — the sandbox
 *   is cached on the same key — so plaintext lives for the sandbox's
 *   lifetime. Simpler than per-invocation decrypt and equivalent in
 *   information exposure.
 *
 * Ordering invariant (load-bearing — see SECURITY.md R-10):
 *   This plugin MUST run BEFORE every other plugin that implements
 *   `onPost`. `runOnPost` threads each message through every plugin's
 *   `onPost` in topo order; running first means downstream `onPost`
 *   plugins only ever observe already-scrubbed messages. If a
 *   downstream `onPost` throws, `worker.ts` posts a
 *   `sandbox.plugin.onPost_failed` log entry directly via
 *   `port.postMessage`, bypassing the scrubber pipeline; because the
 *   thrown Error's message can only reference scrubbed inputs, that
 *   bypass is safe. Today `secrets` is the only plugin with `onPost`,
 *   so the invariant is trivially met — but any future plugin adding
 *   `onPost` MUST be ordered AFTER `secrets` in the descriptor list
 *   built in `sandbox-store.ts#buildPluginDescriptors`.
 *
 * Security (SECURITY.md R-10):
 *   - `onPost` is a cross-cutting hook; documented rationale is uniform
 *     plaintext-literal redaction.
 *   - `onPost` MUST NEVER throw with a message that references a
 *     plaintext value. The body below is wrapped in try/catch that
 *     returns a generic placeholder log on failure so neither the
 *     original (possibly-plaintext-bearing) message nor the caught
 *     error leaves this function on the exception path.
 *   - `addSecret` is a guest-callable descriptor (`public: false`), so
 *     Phase 3 deletes `globalThis["$secrets/addSecret"]` before user
 *     source runs — tenant code reaches it only via the locked
 *     `globalThis.$secrets.addSecret(value)` wrapper whose `raw`
 *     reference was captured during guest() (before Phase 3).
 */

interface SecretsConfig {
	readonly name: string;
	readonly env: Record<string, string>;
	// Decrypted plaintext store keyed by envName. Keys are disjoint from
	// `env` by manifest validation. An empty object is valid.
	readonly plaintextStore: Record<string, string>;
}

const name = "secrets";

// Well-known name of the private guest-function descriptor that returns
// the per-sandbox config bundle to `guest()` at Phase-2 eval time. Kept in
// sync with the string literal in `guest()` — the guest-side code MUST NOT
// import this constant because it's evaluated in an IIFE bundle.
const SECRETS_CONFIG_DESCRIPTOR = "__secretsConfig";
// Well-known name of the private guest-function bridge that registers a
// runtime-added plaintext with the scrubber. Captured into the
// `globalThis.$secrets` closure at Phase 2 before Phase-3 private-delete.
const ADD_SECRET_DESCRIPTOR = "$secrets/addSecret";

// Worker-module-scoped plaintext set, keyed by value (longest-first for
// correct `replaceAll` behaviour on partially-overlapping secrets). Per-
// sandbox isolation: the plugin is re-instantiated per sandbox, so each
// sandbox owns a fresh list.
let activePlaintexts: string[] = [];

function resortLongestFirst(): void {
	activePlaintexts.sort((a, b) => b.length - a.length);
}

function scrubString(s: string): string {
	if (activePlaintexts.length === 0) {
		return s;
	}
	let out = s;
	for (const pt of activePlaintexts) {
		if (pt.length > 0 && out.includes(pt)) {
			out = out.replaceAll(pt, "[secret]");
		}
	}
	return out;
}

function walkStrings<T>(value: T, transform: (s: string) => string): T {
	if (typeof value === "string") {
		return transform(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((v) => walkStrings(v, transform)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = walkStrings(v, transform);
		}
		return out as unknown as T;
	}
	return value;
}

function addSecretDescriptor(): GuestFunctionDescription {
	return {
		name: ADD_SECRET_DESCRIPTOR,
		args: [Guest.string()],
		result: Guest.void(),
		handler: (...args: unknown[]) => {
			const value = args[0];
			if (typeof value !== "string" || value.length === 0) {
				return;
			}
			if (!activePlaintexts.includes(value)) {
				activePlaintexts.push(value);
				resortLongestFirst();
			}
		},
		// The `.request` event fires synchronously before the handler runs, so
		// `activePlaintexts` does not yet contain `args[0]` at emit time and
		// the scrubber cannot redact it. Replace input with a sentinel before
		// emission — the plaintext value has no audit value anyway.
		logInput: () => ["[secret]"],
		public: false,
	};
}

function getSecretsConfigDescriptor(
	config: SecretsConfig,
): GuestFunctionDescription {
	// Bundles `env` (plaintext env + decrypted secrets — disjoint by manifest
	// validation) into a single map so the guest sees one namespace.
	const mergedEnv: Record<string, string> = {
		...config.env,
		...config.plaintextStore,
	};
	const bundle = {
		name: config.name,
		env: mergedEnv,
	};
	return {
		name: SECRETS_CONFIG_DESCRIPTOR,
		args: [],
		result: Guest.raw(),
		handler: () => bundle,
		public: false,
	};
}

function worker(
	_ctx: unknown,
	_deps: unknown,
	config: SecretsConfig,
): PluginSetup {
	// Seed the worker-side plaintext list from the config. This runs once
	// per sandbox construction; any runtime additions (via `secret()`) are
	// appended by the `addSecret` host handler.
	activePlaintexts = Object.values(config.plaintextStore ?? {}).filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
	resortLongestFirst();

	return {
		guestFunctions: [getSecretsConfigDescriptor(config), addSecretDescriptor()],
		onPost(msg: WorkerToMain): WorkerToMain {
			if (activePlaintexts.length === 0) {
				return msg;
			}
			try {
				return walkStrings(msg, scrubString);
			} catch {
				// A throw here is a bug in the scrubber itself (e.g. a message
				// with a throwing getter). Do NOT return `msg` — it is the
				// pre-scrub value and may carry plaintext. Do NOT include the
				// caught error — it may also reference plaintext. Surface only
				// the fact that scrubbing failed; the lost payload is the
				// acceptable cost of never leaking on the exception path.
				return {
					type: "log",
					level: "error",
					message: "sandbox.plugin.secrets_scrub_failed",
					meta: {},
				};
			}
		},
	};
}

// Guest-side Phase-2 IIFE — consumes the private descriptors installed by
// worker() and installs the locked `globalThis.workflow` + `globalThis.$secrets`
// surfaces for tenant code. Captures `$secrets/addSecret` into a closure
// BEFORE Phase 3's private-delete — a dynamic `globalThis[...]` lookup at
// call time would return undefined (Phase 3 already deleted it) and make
// `$secrets.addSecret` a silent no-op, defeating the scrubber for every
// runtime-computed plaintext.
function guest(): void {
	interface ConfigBundle {
		readonly name: string;
		readonly env: Record<string, string>;
	}
	type AddSecret = (value: string) => void;
	const g = globalThis as unknown as Record<string, unknown>;
	const getConfig = g.__secretsConfig as () => ConfigBundle;
	const rawAddSecret = g["$secrets/addSecret"] as AddSecret | undefined;
	const cfg = getConfig();
	const workflow = Object.freeze({
		name: cfg.name,
		env: Object.freeze({ ...cfg.env }),
	});
	Object.defineProperty(globalThis, "workflow", {
		value: workflow,
		writable: false,
		configurable: false,
	});
	const secretsBridge = Object.freeze({
		addSecret: (value: string) => {
			if (typeof rawAddSecret === "function") {
				rawAddSecret(value);
			}
		},
	});
	Object.defineProperty(globalThis, "$secrets", {
		value: secretsBridge,
		writable: false,
		configurable: false,
	});
}

export type { SecretsConfig };
export { guest, name, worker };
