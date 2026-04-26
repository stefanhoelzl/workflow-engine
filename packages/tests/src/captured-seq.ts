import type { CapturedSeq } from "./types.js";

// PR 1 ships the wrapper shape; `byLabel` throws "not implemented" until
// PR 6 (when `.workflow`/`.upload`/`.fetch`/etc. accept `label`).
function createCapturedSeq<T>(
	items: readonly T[],
	labelMap?: ReadonlyMap<string, T>,
): CapturedSeq<T> {
	const arr = items.slice() as T[] & {
		byIndex(i: number): T;
		byLabel(name: string): T;
	};
	Object.defineProperty(arr, "byIndex", {
		value(i: number): T {
			const item = arr[i];
			if (item === undefined) {
				throw new Error(
					`CapturedSeq.byIndex(${String(i)}): out of range (length=${String(arr.length)})`,
				);
			}
			return item;
		},
		enumerable: false,
	});
	Object.defineProperty(arr, "byLabel", {
		value(name: string): T {
			if (!labelMap) {
				throw new Error(
					"CapturedSeq.byLabel: not implemented in this build (PR 6)",
				);
			}
			const item = labelMap.get(name);
			if (item === undefined) {
				throw new Error(`CapturedSeq.byLabel("${name}"): no such label`);
			}
			return item;
		},
		enumerable: false,
	});
	return arr as CapturedSeq<T>;
}

export { createCapturedSeq };
