// Concurrency-capped Promise.all: accepts an array of async task factories
// and runs at most `concurrency` in flight at a time, preserving result
// order. Used by the WPT runner to cap concurrent sandboxes to N.

async function limitedAll<T>(
	tasks: readonly (() => Promise<T>)[],
	concurrency: number,
): Promise<T[]> {
	if (concurrency < 1) {
		throw new Error(`limitedAll: concurrency must be >= 1, got ${concurrency}`);
	}
	const results: T[] = new Array(tasks.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= tasks.length) {
				return;
			}
			const task = tasks[i];
			if (!task) {
				return;
			}
			results[i] = await task();
		}
	}
	const workers = Array.from(
		{ length: Math.min(concurrency, tasks.length) },
		worker,
	);
	await Promise.all(workers);
	return results;
}

export { limitedAll };
