import { createHash } from "node:crypto";
import { type Sandbox, type SandboxOptions, sandbox } from "./index.js";

interface Logger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

interface SandboxFactory {
	create(source: string, options?: SandboxOptions): Promise<Sandbox>;
	dispose(): Promise<void>;
}

const HASH_PREFIX_LEN = 12;

// Log-safe identifier for a source string: short, stable, no bundle content.
function sourceHash(source: string): string {
	return createHash("sha256")
		.update(source)
		.digest("hex")
		.slice(0, HASH_PREFIX_LEN);
}

function createSandboxFactory(opts: { logger: Logger }): SandboxFactory {
	const { logger } = opts;
	const cache = new Map<string, Sandbox>();

	async function create(
		source: string,
		options?: SandboxOptions,
	): Promise<Sandbox> {
		const existing = cache.get(source);
		if (existing) {
			return existing;
		}

		const hash = sourceHash(source);
		const start = performance.now();
		const sb = await sandbox(source, {}, options);
		const durationMs = Math.round(performance.now() - start);

		sb.onDied((err) => {
			logger.warn("sandbox died", {
				sourceHash: hash,
				error: err.message,
			});
			if (cache.get(source) === sb) {
				cache.delete(source);
			}
			sb.dispose();
		});

		cache.set(source, sb);
		logger.info("sandbox created", { sourceHash: hash, durationMs });
		return sb;
	}

	function dispose(): Promise<void> {
		for (const [source, sb] of cache) {
			sb.dispose();
			logger.info("sandbox disposed", {
				sourceHash: sourceHash(source),
				reason: "factory.dispose",
			});
		}
		cache.clear();
		return Promise.resolve();
	}

	return { create, dispose };
}

export type { Logger, SandboxFactory };
export { createSandboxFactory };
