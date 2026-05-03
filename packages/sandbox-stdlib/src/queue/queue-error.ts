import type { QueueErrorCode } from "@workflow-engine/core";
import { GuestSafeError } from "@workflow-engine/sandbox";

interface QueueErrorOptions {
	readonly code: QueueErrorCode;
	readonly message: string;
	// On `queue.schemaMismatch` from `get`, the popped item that failed
	// validation is carried here so operators can recover it from the paired
	// `system.error` event payload (the item is otherwise lost — `get` already
	// removed it from the queue file by the time the throw happens).
	readonly item?: unknown;
}

/**
 * Bridge-safe queue error. Exactly five `code` values are produced by the
 * queue plugin; see `openspec/specs/queues/spec.md` and
 * `openspec/specs/invocations/spec.md`. Host file paths and filesystem errno
 * values are NEVER forwarded; the plugin maps low-level failures (`ENOENT`,
 * `ELOOP`) to `queue.gone` before throwing across the bridge.
 */
class QueueError extends GuestSafeError {
	override readonly name = "QueueError";
	readonly code: QueueErrorCode;
	readonly item?: unknown;

	constructor(options: QueueErrorOptions) {
		super(options.message);
		this.code = options.code;
		if (options.item !== undefined) {
			this.item = options.item;
		}
	}
}

export type { QueueErrorOptions };
export { QueueError };
