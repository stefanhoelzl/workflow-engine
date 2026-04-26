import type { CapturedSeq } from "./types.js";

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
	const map = labelMap ?? new Map<string, T>();
	Object.defineProperty(arr, "byLabel", {
		value(name: string): T {
			const item = map.get(name);
			if (item === undefined) {
				const known =
					map.size === 0
						? "(no labels recorded)"
						: `known labels: ${[...map.keys()].map((k) => `"${k}"`).join(", ")}`;
				throw new Error(
					`CapturedSeq.byLabel("${name}"): no such label; ${known}`,
				);
			}
			return item;
		},
		enumerable: false,
	});
	return arr as CapturedSeq<T>;
}

export { createCapturedSeq };
