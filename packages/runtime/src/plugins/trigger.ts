import type {
	PluginRunResult,
	PluginSetup,
	RunInput,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { serializeLifecycleError } from "@workflow-engine/sandbox";

/**
 * Emits `trigger.request`/`trigger.response`/`trigger.error` around every
 * guest-export invocation via the sandbox's run-lifecycle hooks:
 *   - `onBeforeRunStarted` opens the frame (`createsFrame: true`) so nested
 *     emissions (fetch.*, timer.*, action.*) parent under `trigger.request`.
 *   - `onRunFinished` closes the frame with the terminal kind.
 * Composition without this plugin produces silent runs.
 */
const name = "trigger";

function worker(ctx: SandboxContext): PluginSetup {
	return {
		onBeforeRunStarted(runInput: RunInput): boolean {
			ctx.emit(
				"trigger.request",
				runInput.name,
				{ input: runInput.input },
				{ createsFrame: true },
			);
			return true;
		},
		onRunFinished(result: PluginRunResult, runInput: RunInput): void {
			if (result.ok) {
				ctx.emit(
					"trigger.response",
					runInput.name,
					{ input: runInput.input, output: result.output },
					{ closesFrame: true },
				);
				return;
			}
			ctx.emit(
				"trigger.error",
				runInput.name,
				{
					input: runInput.input,
					error: serializeLifecycleError(result.error),
				},
				{ closesFrame: true },
			);
		},
	};
}

export type { LifecycleError as SerializedTriggerError } from "@workflow-engine/sandbox";
export { name, worker };
