// Wire shapes for the `$queue/do` bridge result + the per-run extras the
// runtime stamps. Types-only module so the guest pass can import freely.
//
// The guest→worker INPUT shape (`{op, name, item?}`) is read inline in the
// worker dispatcher (it routes on `op` and passes `name`/`item` through to
// the host); the host-call contract module (host-contract.ts) is the typed
// boundary for what crosses to main. So only the RESULT wires and the
// per-run extras need shared declarations here.

// `put` returns `null` (no payload). `get` returns the popped item or
// `null` for empty queue. The wire keeps `null` instead of `undefined`
// because `JSON.stringify(undefined) === undefined` and the bridge prefers
// explicit nulls.
type QueuePutResultWire = null;
interface QueueGetResultEmpty {
	readonly found: false;
}
interface QueueGetResultFound {
	readonly found: true;
	readonly item: unknown;
}
type QueueGetResultWire = QueueGetResultEmpty | QueueGetResultFound;
type QueueResultWire = QueuePutResultWire | QueueGetResultWire;

// Per-invocation context delivered via `RunInput.extras`. The runtime stamps
// these fields before each `sb.run` so the queue worker can forward them via
// the host-call channel to the queue.put / queue.get handlers. `extras` may
// also carry fields owned by other plugins (existing convention: `extras` is
// a free-form per-run channel), so the queue plugin reads only the `queue`
// sub-key it owns. `owner` and `workflow` are sandbox-stable and captured
// host-side in the queue handler closure; only per-run fields cross here.
interface QueueRunExtras {
	readonly queue?: {
		readonly repo: string;
		readonly invocationId: string;
		readonly triggerKind: string;
		readonly triggerName: string;
	};
}

export type {
	QueueGetResultEmpty,
	QueueGetResultFound,
	QueueGetResultWire,
	QueuePutResultWire,
	QueueResultWire,
	QueueRunExtras,
};
