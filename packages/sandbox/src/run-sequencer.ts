import type { EventKind, SandboxEvent } from "@workflow-engine/core";
import type { Logger } from "./logger.js";
import type { WireEvent } from "./protocol.js";

interface CallMapEntry {
	readonly openSeq: number;
	readonly name: string;
	readonly kind: string;
	// Pre-computed close-kind for death-path synthesis. Stored at open time so
	// the sequencer never re-parses the open's `kind` string — keeps the
	// "kind is opaque metadata; do not parse for framing" invariant intact.
	readonly closeKind: string;
}

interface RunSequencer {
	/** Open the run window. Idempotent on already-zero state. */
	start(): void;
	/**
	 * Stamp `seq` and `ref` from the wire event's `type` discriminator and
	 * return a fully-shaped SandboxEvent. Returns null when the event must
	 * be dropped: out-of-window (start() not called or finish() already
	 * called) or close-without-matching-open. Both drop paths log via the
	 * injected logger.
	 */
	next(wireEvent: WireEvent): SandboxEvent | null;
	/**
	 * Close the run window. With `closeReason` (worker-death path):
	 * synthesise LIFO close events for every still-open frame, returning
	 * them for the caller to forward through `sb.onEvent`. Without it
	 * (clean-end path): warn via logger if any frames are dangling, drop
	 * them silently, return empty array.
	 *
	 * Always zeroes state and flips `runActive` to false.
	 */
	finish(opts?: { readonly closeReason: string }): SandboxEvent[];
}

/**
 * Compute the synthesis kind for a death-path close from a captured open's
 * kind: take the prefix up to (but not including) the first `.` and append
 * `.error`. Failsafe — works regardless of whether the open's suffix
 * follows the `.request` convention. See design.md D2 "Death-path
 * synthesis kind derivation."
 */
function synthCloseKind(openKind: string): string {
	const dot = openKind.indexOf(".");
	const prefix = dot === -1 ? openKind : openKind.slice(0, dot);
	return `${prefix}.error`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups sequencer state (seq, refStack, callMap, runActive), the three lifecycle methods (start/next/finish), and the SandboxEvent builder as a single cohesive unit
function createRunSequencer(logger: Logger | undefined): RunSequencer {
	let seq = 0;
	const refStack: number[] = [];
	// Map insertion order is meaningful: iterating in reverse gives LIFO
	// synthesis order on death.
	const callMap = new Map<number, CallMapEntry>();
	let runActive = false;
	let lastSeenTs = 0;
	let lastSeenAt = "";

	function start(): void {
		// Defensive: if state isn't zero, something leaked from a prior run
		// (finish() should have zeroed it). Reset and warn.
		if (seq !== 0 || refStack.length > 0 || callMap.size > 0) {
			logger?.warn("sandbox.sequencer_dirty_start", {
				seq,
				refStackDepth: refStack.length,
				callMapSize: callMap.size,
			});
			seq = 0;
			refStack.length = 0;
			callMap.clear();
		}
		runActive = true;
	}

	function buildSandboxEvent(
		wire: WireEvent,
		assignedSeq: number,
		ref: number | null,
	): SandboxEvent {
		// Wire `kind` is typed as string (free-form); SandboxEvent on the bus
		// is typed against the closed `EventKind` union. The cast happens at
		// this boundary — runtime widening trusts the bridge to emit known
		// kinds; non-blessed kinds flow through as opaque strings.
		const event: SandboxEvent = {
			kind: wire.kind as EventKind,
			seq: assignedSeq,
			ref,
			at: wire.at,
			ts: wire.ts,
			name: wire.name,
			...(wire.input === undefined ? {} : { input: wire.input }),
			...(wire.output === undefined ? {} : { output: wire.output }),
			...(wire.error === undefined ? {} : { error: wire.error }),
		};
		return event;
	}

	function next(wire: WireEvent): SandboxEvent | null {
		if (!runActive) {
			logger?.warn("sandbox.event_outside_run", {
				kind: wire.kind,
				name: wire.name,
				at: wire.at,
			});
			return null;
		}

		// Track last-seen ts/at for death-synthesis.
		lastSeenTs = wire.ts;
		lastSeenAt = wire.at;

		const framing = wire.type;

		if (framing === "leaf") {
			const assignedSeq = seq++;
			const ref = refStack.at(-1) ?? null;
			return buildSandboxEvent(wire, assignedSeq, ref);
		}

		if ("open" in framing) {
			const assignedSeq = seq++;
			const ref = refStack.at(-1) ?? null;
			refStack.push(assignedSeq);
			callMap.set(framing.open, {
				openSeq: assignedSeq,
				name: wire.name,
				kind: wire.kind,
				closeKind: synthCloseKind(wire.kind),
			});
			return buildSandboxEvent(wire, assignedSeq, ref);
		}

		return handleClose(wire, framing.close);
	}

	function handleClose(wire: WireEvent, callId: number): SandboxEvent | null {
		const entry = callMap.get(callId);
		if (entry === undefined) {
			logger?.warn("sandbox.close_without_open", {
				kind: wire.kind,
				name: wire.name,
				callId,
			});
			return null;
		}
		const assignedSeq = seq++;
		// Common case is LIFO (synchronous open/close pairs) — pop the top
		// without scanning. Fall back to splice for concurrent-Promise.all
		// closes that interleave out of order.
		if (refStack.at(-1) === entry.openSeq) {
			refStack.pop();
		} else {
			const idx = refStack.lastIndexOf(entry.openSeq);
			if (idx !== -1) {
				refStack.splice(idx, 1);
			}
		}
		callMap.delete(callId);
		return buildSandboxEvent(wire, assignedSeq, entry.openSeq);
	}

	function finish(opts?: { readonly closeReason: string }): SandboxEvent[] {
		const synthesised: SandboxEvent[] = [];

		if (callMap.size > 0) {
			if (opts === undefined) {
				// Plugin-bug path: dangling frames after a clean run end.
				// Log and drop.
				logger?.warn("sandbox.dangling_frame", {
					count: callMap.size,
					kinds: Array.from(callMap.values()).map((e) => e.kind),
				});
			} else {
				// Death-path: synthesise LIFO closes for every still-open frame.
				// Map insertion order is FIFO; reverse to get LIFO (deepest
				// first).
				const entries = Array.from(callMap.values()).reverse();
				for (const entry of entries) {
					const assignedSeq = seq++;
					const synthEvent: SandboxEvent = {
						kind: entry.closeKind as EventKind,
						seq: assignedSeq,
						ref: entry.openSeq,
						at: lastSeenAt,
						ts: lastSeenTs,
						name: entry.name,
						// No stack — the worker process is gone, no JS frame
						// exists to capture. `InvocationEventError.stack` is
						// optional; omitting beats fabricating an empty string.
						error: {
							message: opts.closeReason,
						},
					};
					synthesised.push(synthEvent);
				}
			}
		}

		// Zero state and close the window. Reset lastSeenTs/At too so a
		// double-finish() can't leak prior-run timestamps onto fresh
		// synthetic events.
		seq = 0;
		refStack.length = 0;
		callMap.clear();
		runActive = false;
		lastSeenTs = 0;
		lastSeenAt = "";

		return synthesised;
	}

	return { start, next, finish };
}

export type { RunSequencer };
export { createRunSequencer, synthCloseKind };
