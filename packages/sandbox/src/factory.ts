import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import { type Sandbox, type SandboxOptions, sandbox } from "./sandbox.js";

// Factory-level resource limits. Sourced from the runtime config
// (`SANDBOX_LIMIT_*` fields in `packages/runtime/src/config.ts`) once at
// startup and forwarded into every `create()` call — individual call sites
// don't pass limits per-invocation.
type SandboxResourceLimits = Pick<
	SandboxOptions,
	"memoryBytes" | "stackBytes" | "cpuMs" | "outputBytes" | "pendingCallables"
>;

type FactoryCreateOptions = Omit<
	SandboxOptions,
	keyof SandboxResourceLimits | "logger"
>;

// Pure builder: no lifetime tracking, no `dispose()`, no termination
// subscription. Sandbox lifetime is owned by the consumer (in production
// `SandboxStore`; in tests, the test fixture). See
// `openspec/specs/sandbox/spec.md` "Factory-wide dispose" — the SandboxFactory
// SHALL NOT track lifetimes and SHALL NOT expose a `dispose()` method.
interface SandboxFactory {
	create(options: FactoryCreateOptions): Promise<Sandbox>;
}

const HASH_PREFIX_LEN = 12;

function sourceHash(source: string): string {
	return createHash("sha256")
		.update(source)
		.digest("hex")
		.slice(0, HASH_PREFIX_LEN);
}

interface FactoryDeps extends SandboxResourceLimits {
	readonly logger: Logger;
}

function createSandboxFactory(opts: FactoryDeps): SandboxFactory {
	const {
		logger,
		memoryBytes,
		stackBytes,
		cpuMs,
		outputBytes,
		pendingCallables,
	} = opts;

	async function create(options: FactoryCreateOptions): Promise<Sandbox> {
		const hash = sourceHash(options.source);
		const start = performance.now();
		const sb = await sandbox({
			...options,
			memoryBytes,
			stackBytes,
			cpuMs,
			outputBytes,
			pendingCallables,
			logger,
		});
		const durationMs = Math.round(performance.now() - start);
		logger.info("sandbox created", { sourceHash: hash, durationMs });
		return sb;
	}

	return { create };
}

export type { FactoryCreateOptions, SandboxFactory, SandboxResourceLimits };
export { createSandboxFactory };
