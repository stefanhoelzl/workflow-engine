import type {
	CallId,
	PluginRunResult,
	PluginSetup,
	RunInput,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { serializeLifecycleError } from "@workflow-engine/sandbox";

/**
 * Emits `trigger.request`/`trigger.response`/`trigger.error` around every
 * guest-export invocation via the sandbox's run-lifecycle hooks:
 *   - `onBeforeRunStarted` opens the frame (`type: "open"`) and captures the
 *     CallId returned from `ctx.emit` into setup-state.
 *   - `onRunFinished` closes the frame by passing the captured CallId on
 *     `type: { close: callId }`. The pairing is structurally enforced by
 *     the SDK type system.
 * Composition without this plugin produces silent runs.
 */
const name = "trigger";

function worker(ctx: SandboxContext): PluginSetup {
	// Captured between onBeforeRunStarted (open) and onRunFinished (close).
	// PluginSetup host-side state is allowed to persist between hooks per
	// SECURITY.md R-4. Sandbox is single-run-at-a-time, so a single slot is
	// sufficient.
	let openCallId: CallId | null = null;

	return {
		onBeforeRunStarted(runInput: RunInput): boolean {
			openCallId = ctx.emit("trigger.request", {
				name: runInput.name,
				input: runInput.input,
				type: "open",
			});
			return true;
		},
		onRunFinished(result: PluginRunResult, runInput: RunInput): void {
			if (openCallId === null) {
				// onBeforeRunStarted didn't fire — nothing to close.
				return;
			}
			const callId = openCallId;
			openCallId = null;
			if (result.ok) {
				ctx.emit("trigger.response", {
					name: runInput.name,
					input: runInput.input,
					output: result.output,
					type: { close: callId },
				});
				return;
			}
			ctx.emit("trigger.error", {
				name: runInput.name,
				input: runInput.input,
				error: serializeLifecycleError(result.error),
				type: { close: callId },
			});
		},
	};
}

export type { LifecycleError as SerializedTriggerError } from "@workflow-engine/sandbox";
export { name, worker };
