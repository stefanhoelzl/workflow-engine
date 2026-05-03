// Queue plugin entry file. The `?sandbox-plugin` vite transform produces
// two independent rollup bundles from this file (mirrors `sql/`, `mail/`):
//
//   • WORKER PASS — synthetic entry `export { worker as default }`. Only
//     `worker` is reachable; its transitive imports (worker.ts → node:fs,
//     node:path, node:crypto, zod) are bundled into `workerSource` as an
//     ESM string.
//
//   • GUEST PASS — synthetic entry `import { guest } from ...; guest()`.
//     The worker re-export is unreachable from guest() and gets DCE'd along
//     with worker.ts and its node:* imports. Hence worker.ts lives in a
//     separate file: if the node imports lived here, the guest pass's
//     `moduleSideEffects: "no-external"` would preserve them as side-
//     effectful and pull node:fs into a QuickJS IIFE that has no Node
//     surface to run it.

// biome-ignore lint/style/noExportedImports: QUEUE_DISPATCHER_NAME is consumed inside this file AND re-exported so worker.ts (and tests) reference the same constant
import { QUEUE_DISPATCHER_NAME } from "./descriptor-name.js";

const name = "queue";
const dependsOn: readonly string[] = ["web-platform"];

// Phase-2 IIFE: capture `$queue/do` into a locked `__queue` global with a
// frozen inner `{put, get}`, so tenant code cannot replace the dispatcher.
// Phase-3 deletes the raw `$queue/do` binding (public !== true).
function guest(): void {
	type DispatchFn = (input: unknown) => Promise<unknown>;
	const g = globalThis as unknown as Record<string, unknown>;
	const raw = g[QUEUE_DISPATCHER_NAME] as DispatchFn;
	const queueApi = Object.freeze({
		put: async (queueName: string, item: unknown): Promise<void> => {
			await raw({ op: "put", name: queueName, item });
		},
		get: async (queueName: string): Promise<unknown> => {
			const result = (await raw({ op: "get", name: queueName })) as
				| { found: false }
				| { found: true; item: unknown };
			if (result.found === false) {
				return;
			}
			return result.item;
		},
	});
	Object.defineProperty(globalThis, "__queue", {
		value: queueApi,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

export type {
	QueueGetInput,
	QueueGetResultWire,
	QueueInputWire,
	QueuePutInput,
	QueuePutResultWire,
	QueueResultWire,
	QueueRunExtras,
} from "./types.js";
export type { Config } from "./worker.js";
// biome-ignore lint/performance/noBarrelFile: the `?sandbox-plugin` vite transform discovers `worker` through this file's re-export; the guest pass DCEs worker.ts so the re-export costs nothing at runtime
export { worker } from "./worker.js";
export { dependsOn, guest, name, QUEUE_DISPATCHER_NAME };
