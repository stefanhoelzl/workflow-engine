import { SENTINEL_SUBSTRING_RE } from "@workflow-engine/core";

/**
 * Deep-walks `value`, replacing every `\x00secret:NAME\x00` sentinel
 * substring (see `encodeSentinel` in `@workflow-engine/core`) with the
 * corresponding entry in `plaintextStore`. Missing names are accumulated
 * into `missing` and their sentinels are left in place; callers throw
 * after the walk completes so every missing name is reported at once.
 *
 * Plain JavaScript objects and arrays are traversed recursively; every
 * other value (strings aside) is passed through unchanged. Strings are
 * rebuilt via `String.prototype.replace`, so input strings with no
 * sentinels are returned byte-identical.
 *
 * Called from the workflow registry before it dispatches trigger entries
 * to `TriggerSource.reconfigure`. `TriggerSource` implementations MUST
 * NOT observe or parse sentinels themselves (see
 * `openspec/specs/workflow-secrets/spec.md` — "Main-thread plaintext
 * confinement within engine code" and "Workflow registration resolves
 * sentinel substrings before TriggerSource.reconfigure").
 */
function resolveSecretSentinels<T>(
	value: T,
	plaintextStore: Readonly<Record<string, string>>,
	missing: Set<string>,
): T {
	if (typeof value === "string") {
		return resolveString(value, plaintextStore, missing) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((v) =>
			resolveSecretSentinels(v, plaintextStore, missing),
		) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = resolveSecretSentinels(v, plaintextStore, missing);
		}
		return out as unknown as T;
	}
	return value;
}

function resolveString(
	s: string,
	store: Readonly<Record<string, string>>,
	missing: Set<string>,
): string {
	if (!s.includes("\x00secret:")) {
		return s;
	}
	return s.replace(SENTINEL_SUBSTRING_RE, (match, name: string) => {
		if (Object.hasOwn(store, name)) {
			return store[name] as string;
		}
		missing.add(name);
		return match;
	});
}

export { resolveSecretSentinels };
