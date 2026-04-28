import { describe, expect, it } from "vitest";
import { sandbox } from "./index.js";
import type { Logger } from "./logger.js";
import type { PluginDescriptor } from "./plugin.js";
import { TEST_SANDBOX_LIMITS } from "./test-harness.js";

// Regression for the historical race fixed by `build-new-VM-before-dispose-
// old` in startRestore: a host-callback resolved by guest async just before
// `post({type:"done"})` could call into the about-to-be-disposed VM, surfaced
// under concurrent WPT load (idlharness, fetch suites). Structural fix lives
// in the run-end Callable-leak audit (`runLifecycleAfter` in worker.ts):
// every Callable left live by a plugin's `onRunFinished` drain is logged
// with its descriptor name and auto-disposed BEFORE the bridge gate flips
// and BEFORE the post-run VM dispose. That converts a future worker crash
// (vm.callFunction on a disposed VM) into a defined `CallableDisposedError`
// from `Callable.invoke`. The audit is the load-bearing protection; the
// `dispose-then-restore` ordering in startRestore was reverted because it
// is now redundant.

// Self-contained leaky plugin source. The plugin exposes `captureCallable`,
// a host function that takes a guest Callable and stashes it on a closure-
// local list — and crucially does NOT dispose any of them in onRunFinished.
// Every guest call to `captureCallable(fn)` produces one leak the audit
// must catch.
const LEAKY_PLUGIN_SOURCE = `
export default function worker(ctx) {
    const captured = [];
    return {
        guestFunctions: [
            {
                name: "captureCallable",
                args: [{ kind: "callable" }],
                result: { kind: "void" },
                handler: (cb) => { captured.push(cb); },
                log: { event: "system.call" },
                logInput: () => ({}),
                public: true,
            },
        ],
        // Deliberately no onRunFinished — drain audit must catch the leak.
    };
}
`;

const LEAKY_PLUGIN: PluginDescriptor = {
	name: "leaky",
	workerSource: LEAKY_PLUGIN_SOURCE,
};

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

interface CapturedLog {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	meta?: Record<string, unknown>;
}

function recordingLogger(): { logs: CapturedLog[]; logger: Logger } {
	const logs: CapturedLog[] = [];
	const push = (
		level: CapturedLog["level"],
		message: string,
		meta?: Record<string, unknown>,
	) => {
		logs.push({ level, message, ...(meta === undefined ? {} : { meta }) });
	};
	return {
		logs,
		logger: {
			info: (m, meta) => push("info", m, meta),
			warn: (m, meta) => push("warn", m, meta),
			error: (m, meta) => push("error", m, meta),
			debug: (m, meta) => push("debug", m, meta),
		},
	};
}

describe("Callable leak audit at end of runLifecycleAfter", () => {
	it("logs sandbox.plugin.callable_leak naming the descriptor and auto-disposes the leaked Callable so the sandbox stays usable", async () => {
		const { logs, logger } = recordingLogger();
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source: iife(`exports.probe = async function() {
				captureCallable(() => 'a');
				captureCallable(() => 'b');
				return 'ok';
			};`),
			plugins: [LEAKY_PLUGIN],
			logger,
		});
		try {
			const first = await sb.run("probe", {});
			if (!first.ok) {
				throw new Error(`first run failed: ${first.error.message}`);
			}
			expect(first.result).toBe("ok");
			// Both leaked Callables surfaced as `sandbox.plugin.callable_leak`
			// error logs naming the descriptor.
			const leakLogs = logs.filter(
				(l) => l.message === "sandbox.plugin.callable_leak",
			);
			expect(leakLogs).toHaveLength(2);
			expect(leakLogs.every((l) => l.level === "error")).toBe(true);
			expect(
				leakLogs.every((l) => l.meta?.descriptor === "captureCallable"),
			).toBe(true);

			// Sandbox must remain usable across runs — i.e. the post-run
			// VM dispose did not race a stale Callable invocation.
			const second = await sb.run("probe", {});
			expect(second.ok).toBe(true);
			// Second run produces its own pair of leaks, accumulated.
			const leakLogsAfterSecond = logs.filter(
				(l) => l.message === "sandbox.plugin.callable_leak",
			);
			expect(leakLogsAfterSecond).toHaveLength(4);
		} finally {
			await sb.dispose();
		}
	});

	it("a clean plugin with no leaks emits no callable_leak logs", async () => {
		// Inverse control: the sdk-host pattern (capture → invoke → dispose
		// in onRunFinished) must not trip the audit. We model that with a
		// plugin that disposes the captured Callable when run finishes.
		const CLEAN_PLUGIN_SOURCE = `
export default function worker(ctx) {
    const captured = [];
    return {
        guestFunctions: [
            {
                name: "captureClean",
                args: [{ kind: "callable" }],
                result: { kind: "void" },
                handler: (cb) => { captured.push(cb); },
                log: { event: "system.call" },
                logInput: () => ({}),
                public: true,
            },
        ],
        onRunFinished() {
            for (const cb of captured) cb.dispose();
            captured.length = 0;
        },
    };
}
`;
		const { logs, logger } = recordingLogger();
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source: iife(`exports.probe = async function() {
				captureClean(() => 'x');
				return 'ok';
			};`),
			plugins: [{ name: "clean", workerSource: CLEAN_PLUGIN_SOURCE }],
			logger,
		});
		try {
			const r = await sb.run("probe", {});
			expect(r.ok).toBe(true);
			const leakLogs = logs.filter(
				(l) => l.message === "sandbox.plugin.callable_leak",
			);
			expect(leakLogs).toHaveLength(0);
		} finally {
			await sb.dispose();
		}
	});
});
