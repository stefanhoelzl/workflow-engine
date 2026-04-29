import { createHash } from "node:crypto";
import type {
	PluginContext,
	PluginSetup,
	WasiClockArgs,
	WasiFdWriteArgs,
	WasiRandomArgs,
} from "@workflow-engine/sandbox";
import { WASI_PLUGIN_NAME } from "@workflow-engine/sandbox";

/**
 * Observe-only hooks on the sandbox's WASI slots that emit a leaf event
 * per guest-visible clock read, entropy read, and stdout/stderr write.
 * Hook returns are all `undefined`, leaving WASI's real values in place;
 * replay/mock variants would return `{ ns }` / `{ bytes }` overrides.
 *
 * Security invariant: `randomGet` MUST NOT emit the raw entropy bytes. The
 * event carries `{ bufLen, sha256First16 }` — a 16-hex-char prefix of the
 * SHA-256 digest, non-reversible and insufficient to reconstruct RNG state.
 */
const name = "wasi-telemetry";
const dependsOn: readonly string[] = [WASI_PLUGIN_NAME];

const SHA256_HEX_PREFIX_LEN = 16;

function sha256First16(bytes: Uint8Array): string {
	return createHash("sha256")
		.update(bytes)
		.digest("hex")
		.slice(0, SHA256_HEX_PREFIX_LEN);
}

function worker(ctx: PluginContext): PluginSetup {
	return {
		wasiHooks: {
			clockTimeGet: (args: WasiClockArgs): undefined => {
				ctx.emit("system.call", {
					name: "wasi.clock_time_get",
					input: { label: args.label },
					output: { ns: args.defaultNs },
				});
				return;
			},
			randomGet: (args: WasiRandomArgs): undefined => {
				ctx.emit("system.call", {
					name: "wasi.random_get",
					input: { bufLen: args.bufLen },
					output: {
						bufLen: args.bufLen,
						sha256First16: sha256First16(args.defaultBytes),
					},
				});
				return;
			},
			fdWrite: (args: WasiFdWriteArgs): void => {
				ctx.emit("system.call", {
					name: "wasi.fd_write",
					input: { fd: args.fd, text: args.text },
				});
			},
		},
	};
}

export { dependsOn, name, worker };
