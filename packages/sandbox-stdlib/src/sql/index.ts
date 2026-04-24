// SQL plugin entry file. The `?sandbox-plugin` vite transform produces two
// independent rollup bundles from this file:
//
//   • WORKER PASS — synthetic entry `export { worker as default }`. Only
//     `worker` is reachable; its transitive imports (worker.ts → postgres,
//     net-guard, node:net) are bundled into `workerSource` as an ESM string.
//
//   • GUEST PASS — synthetic entry `import { guest } from ...; guest()`. The
//     worker re-export is unreachable from guest() and gets DCE'd, along
//     with worker.ts and the postgres driver. This is why `worker` lives in
//     a separate file: if driver imports lived at the top of this file,
//     the guest pass's `moduleSideEffects: "no-external"` would preserve
//     them as side-effectful and pull the whole driver into a QuickJS IIFE
//     that has no Node surface to run it.

// biome-ignore lint/style/noExportedImports: SQL_DISPATCHER_NAME is consumed inside this file AND re-exported so worker.ts (and tests) reference the same constant
import { SQL_DISPATCHER_NAME } from "./descriptor-name.js";

const name = "sql";
const dependsOn: readonly string[] = ["web-platform"];

// Phase-2 IIFE: capture `$sql/do` into a locked `__sql` global with a
// frozen inner `{execute}`, so tenant code cannot replace the dispatcher.
// Phase-3 deletes the raw `$sql/do` binding (public !== true).
function guest(): void {
	type ExecuteFn = (input: unknown) => Promise<unknown>;
	const g = globalThis as unknown as Record<string, unknown>;
	const raw = g[SQL_DISPATCHER_NAME] as ExecuteFn;
	const sqlApi = Object.freeze({
		execute: (input: unknown) => raw(input),
	});
	Object.defineProperty(globalThis, "__sql", {
		value: sqlApi,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

export type {
	SqlColumnMetaWire,
	SqlConnectionObjectWire,
	SqlConnectionWire,
	SqlErrorWire,
	SqlInputWire,
	SqlOptionsWire,
	SqlParam,
	SqlResultWire,
	SqlRowWire,
	SqlSslWire,
	SqlValue,
} from "./types.js";
// biome-ignore lint/performance/noBarrelFile: the `?sandbox-plugin` vite transform discovers `worker` through this file's re-export; the guest pass DCEs worker.ts so the re-export costs nothing at runtime
export { worker } from "./worker.js";
export { dependsOn, guest, name, SQL_DISPATCHER_NAME };
