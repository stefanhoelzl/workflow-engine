// Test helpers for plugin authors. Two strategies for exercising guest-side
// behavior that previously lived in hand-authored IIFE strings:
//
//   Strategy A — `withStagedGlobals(stage, fn)`: stages the keys from
//   `stage` onto the real `globalThis` before running `fn`, snapshot-
//   restoring on exit. Suitable for plugins whose `guest()` body reads
//   worker-installed bridges off `globalThis` and writes new globals
//   (e.g. `console`). The test can read the post-`fn` mutations via
//   `globalThis` or the shared stage object that `fn` observed.
//
//   Strategy B — `withPluginSandbox(source, options, fn)`: spins up a real
//   sandbox with the given plugin composition and user source, then calls
//   `fn(sb)`. Disposes on exit even if `fn` throws. Suitable for
//   multi-plugin integration cases (e.g. `sdk-support` captures bridges
//   installed by `host-call-action`).
//
// Neither helper is production code — they live in the package but are
// intended for `*.test.ts` consumers across the monorepo.

import type { Sandbox, SandboxOptions } from "./sandbox.js";
import { sandbox } from "./sandbox.js";

// Generous defaults for unit tests — the real values come from runtime
// config in production (`packages/runtime/src/config.ts`'s
// `SANDBOX_LIMIT_*` fields). Tests that want to exercise a breach override
// the relevant field explicitly.
const TEST_SANDBOX_LIMITS = {
	memoryBytes: 134_217_728,
	stackBytes: 1_048_576,
	cpuMs: 30_000,
	outputBytes: 33_554_432,
	pendingCallables: 1024,
} as const;

type AnyGlobal = Record<string, unknown>;

/**
 * Stages `stage` onto `globalThis`, runs `fn`, then restores every key
 * `stage` defined to its pre-call value (absent keys are re-deleted;
 * present keys are re-assigned to their original value). Throws from `fn`
 * propagate; state is restored in either case.
 */
function withStagedGlobals<T>(stage: Record<string, unknown>, fn: () => T): T {
	const g = globalThis as unknown as AnyGlobal;
	const snapshot = new Map<string, { present: boolean; value: unknown }>();
	for (const key of Object.keys(stage)) {
		snapshot.set(key, {
			present: Object.hasOwn(g, key),
			value: g[key],
		});
		g[key] = stage[key];
	}
	try {
		return fn();
	} finally {
		for (const [key, prior] of snapshot) {
			if (prior.present) {
				g[key] = prior.value;
			} else {
				delete g[key];
			}
		}
	}
}

type WithPluginSandboxOptions = Partial<
	Pick<
		SandboxOptions,
		"memoryBytes" | "stackBytes" | "cpuMs" | "outputBytes" | "pendingCallables"
	>
> &
	Omit<
		SandboxOptions,
		| "source"
		| "memoryBytes"
		| "stackBytes"
		| "cpuMs"
		| "outputBytes"
		| "pendingCallables"
	>;

/**
 * Constructs a real sandbox with the given plugin composition and user
 * source, invokes `fn(sb)`, and disposes on exit regardless of outcome.
 */
async function withPluginSandbox<T>(
	source: string,
	options: WithPluginSandboxOptions,
	fn: (sb: Sandbox) => Promise<T>,
): Promise<T> {
	const sb = await sandbox({ ...TEST_SANDBOX_LIMITS, source, ...options });
	try {
		return await fn(sb);
	} finally {
		sb.dispose();
	}
}

export { TEST_SANDBOX_LIMITS, withPluginSandbox, withStagedGlobals };
