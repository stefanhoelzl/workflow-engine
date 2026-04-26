import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import { type Sandbox, type SandboxOptions, sandbox } from "./sandbox.js";

/** @deprecated Kept as an alias for `SandboxOptions`. Remove in the next breaking change. */
type FactoryCreateOptions = Omit<SandboxOptions, "logger">;

interface SandboxFactory {
	create(options: FactoryCreateOptions): Promise<Sandbox>;
	dispose(): Promise<void>;
}

const HASH_PREFIX_LEN = 12;

function sourceHash(source: string): string {
	return createHash("sha256")
		.update(source)
		.digest("hex")
		.slice(0, HASH_PREFIX_LEN);
}

function createSandboxFactory(opts: { logger: Logger }): SandboxFactory {
	const { logger } = opts;
	const created = new Set<Sandbox>();

	async function create(options: FactoryCreateOptions): Promise<Sandbox> {
		const hash = sourceHash(options.source);
		const start = performance.now();
		const sb = await sandbox({ ...options, logger });
		const durationMs = Math.round(performance.now() - start);

		created.add(sb);
		sb.onDied(() => {
			created.delete(sb);
		});

		logger.info("sandbox created", { sourceHash: hash, durationMs });
		return sb;
	}

	function dispose(): Promise<void> {
		for (const sb of created) {
			sb.dispose();
			logger.info("sandbox disposed", {
				reason: "factory.dispose",
			});
		}
		created.clear();
		return Promise.resolve();
	}

	return { create, dispose };
}

export type { FactoryCreateOptions, SandboxFactory };
export { createSandboxFactory };
