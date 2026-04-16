// Promise-chain serializer.
//
// `run(fn)` returns a Promise that resolves/rejects with `fn`'s result, but
// waits until the previous run has settled (resolved OR rejected) before
// invoking `fn`. A prior failure MUST NOT block subsequent runs — we catch
// and swallow rejection on the chain so the tail stays alive.

interface RunQueue {
	run<T>(fn: () => Promise<T>): Promise<T>;
}

function createRunQueue(): RunQueue {
	// The tail resolves whenever the most-recently-scheduled run settles.
	// Subsequent runs chain off this tail, guaranteeing serialization. We
	// kick it off with Promise.resolve() so the first caller's fn runs on
	// the next microtask (matches a naïve direct-invoke for throughput).
	let tail: Promise<void> = Promise.resolve();

	function run<T>(fn: () => Promise<T>): Promise<T> {
		const myTurn = tail.then(fn);
		// Swallow the result on the tail so a failure here doesn't bubble up
		// into the *next* caller's `tail.then(fn)` — they want to start fresh,
		// not re-throw the prior failure.
		tail = myTurn.then(
			() => undefined,
			() => undefined,
		);
		return myTurn;
	}

	return { run };
}

export type { RunQueue };
export { createRunQueue };
