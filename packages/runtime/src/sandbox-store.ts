import type { WorkflowManifest } from "@workflow-engine/core";
import type {
	PluginDescriptor,
	Sandbox,
	SandboxFactory,
} from "@workflow-engine/sandbox";
// The `?sandbox-plugin` query is intercepted by the `sandboxPlugins()` vite
// transform, which esbuild-bundles the target file's `worker` export into a
// self-contained ESM string (loaded by the worker via `data:` URI). That
// pipeline requires TS source — going through each package's `exports` field
// would resolve to a tsc-built `.js` and lose source-level tree-shaking.
// Hence the raw `../../<pkg>/src/*.ts?sandbox-plugin` shape. The `.ts`
// extension is consumed by vite before emit, so the usual `.js`-extension
// rule (for `verbatimModuleSyntax`) does not apply at these call sites.
import wasiPlugin from "../../sandbox/src/plugins/wasi-plugin.ts?sandbox-plugin";
import consolePlugin from "../../sandbox-stdlib/src/console/index.ts?sandbox-plugin";
import fetchPlugin from "../../sandbox-stdlib/src/fetch/index.ts?sandbox-plugin";
import timersPlugin from "../../sandbox-stdlib/src/timers/index.ts?sandbox-plugin";
import webPlatformPlugin from "../../sandbox-stdlib/src/web-platform/index.ts?sandbox-plugin";
import sdkSupportPlugin from "../../sdk/src/sdk-support/index.ts?sandbox-plugin";
import { compileActionValidators } from "./host-call-action-config.js";
import type { Logger } from "./logger.js";
import hostCallActionPlugin from "./plugins/host-call-action.ts?sandbox-plugin";
import secretsPlugin from "./plugins/secrets.ts?sandbox-plugin";
import triggerPlugin from "./plugins/trigger.ts?sandbox-plugin";
import wasiTelemetryPlugin from "./plugins/wasi-telemetry.ts?sandbox-plugin";
import { decryptWorkflowSecrets } from "./secrets/decrypt-workflow.js";
import type { SecretsKeyStore } from "./secrets/index.js";

// Per-(tenant, sha) sandbox cache. Composes the production plugin list for
// every entry: wasi → wasi-telemetry → web-platform → fetch → timers →
// console → host-call-action → sdk-support → trigger. Plugin sources are
// pre-bundled at build time by `sandboxPlugins()` and loaded via `data:`
// URI import.
//
// Sandboxes are held for the lifetime of the store. Re-upload on a changed
// sha orphans the old `(tenant, oldSha)` sandbox, which remains reachable
// to any in-flight invocation until the process exits.

interface SandboxStore {
	get(
		tenant: string,
		workflow: WorkflowManifest,
		bundleSource: string,
	): Promise<Sandbox>;
	dispose(): void;
}

interface SandboxStoreOptions {
	readonly sandboxFactory: SandboxFactory;
	readonly logger: Logger;
	readonly keyStore: SecretsKeyStore;
}

function storeKey(tenant: string, sha: string): string {
	return `${tenant}/${sha}`;
}

function buildPluginDescriptors(
	workflow: WorkflowManifest,
	keyStore: SecretsKeyStore,
): readonly PluginDescriptor[] {
	// Per-plugin `Config` interfaces are structurally JSON-serializable but
	// TS can't prove they satisfy the index-signature constraint of
	// `SerializableConfig`. `serializePluginDescriptors` asserts the shape
	// at construction time; a widening cast through `unknown` is required.
	const hostCallActionConfig = compileActionValidators(
		workflow,
	) as unknown as PluginDescriptor["config"];
	// Decrypt manifest.secrets once per sandbox — plaintexts live for the
	// sandbox's lifetime (which is scoped to (tenant, workflow.sha), so
	// the ciphertexts on the manifest would be stable anyway).
	const plaintextStore = decryptWorkflowSecrets(workflow, keyStore);
	const secretsConfig = {
		name: workflow.name,
		env: workflow.env,
		plaintextStore,
	} as unknown as PluginDescriptor["config"];
	return [
		{ ...wasiPlugin },
		{ ...wasiTelemetryPlugin },
		{ ...secretsPlugin, config: secretsConfig },
		{ ...webPlatformPlugin },
		{ ...fetchPlugin },
		{ ...timersPlugin },
		{ ...consolePlugin },
		{ ...hostCallActionPlugin, config: hostCallActionConfig },
		{ ...sdkSupportPlugin },
		{ ...triggerPlugin },
	];
}

function createSandboxStore(options: SandboxStoreOptions): SandboxStore {
	const { sandboxFactory, keyStore } = options;
	const cache = new Map<string, Promise<Sandbox>>();

	function build(
		_tenant: string,
		workflow: WorkflowManifest,
		bundleSource: string,
	): Promise<Sandbox> {
		return sandboxFactory.create({
			source: bundleSource,
			filename: `${workflow.name}.js`,
			plugins: buildPluginDescriptors(workflow, keyStore),
		});
	}

	return {
		get(tenant, workflow, bundleSource) {
			const key = storeKey(tenant, workflow.sha);
			const existing = cache.get(key);
			if (existing) {
				return existing;
			}
			const promise = build(tenant, workflow, bundleSource);
			cache.set(key, promise);
			return promise;
		},
		dispose() {
			for (const promise of cache.values()) {
				promise
					.then((sb) => {
						sb.dispose();
					})
					.catch(() => {
						/* ignore disposal errors */
					});
			}
			cache.clear();
		},
	};
}

export type { SandboxStore, SandboxStoreOptions };
export { createSandboxStore };
