// Wire shapes for the `$queue/do` bridge. Shared between the worker
// implementation, host composer, and tests. Types-only module so the guest
// pass can import freely.

interface QueuePutInput {
	readonly op: "put";
	readonly name: string;
	readonly item: unknown;
}

interface QueueGetInput {
	readonly op: "get";
	readonly name: string;
}

type QueueInputWire = QueuePutInput | QueueGetInput;

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
// `(owner, repo)` here before each `sb.run` so the queue plugin can
// construct the on-disk path. `extras` may also carry fields owned by other
// plugins (existing convention: `extras` is a free-form per-run channel),
// so the queue plugin reads only the `queue` sub-key it owns.
interface QueueRunExtras {
	readonly queue?: {
		readonly owner: string;
		readonly repo: string;
	};
}

export type {
	QueueGetInput,
	QueueGetResultEmpty,
	QueueGetResultFound,
	QueueGetResultWire,
	QueueInputWire,
	QueuePutInput,
	QueuePutResultWire,
	QueueResultWire,
	QueueRunExtras,
};
