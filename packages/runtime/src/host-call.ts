import type { z } from "@workflow-engine/core";
import type { HostHandler, HostHandlers } from "@workflow-engine/sandbox";

// Typed wiring for the worker→main host-call channel.
//
// A host-backed capability declares a CONTRACT MODULE: a plain `.ts` that
// exports, per method, a `{ args, result }` pair of Zod schemas. The worker
// side imports only the inferred TYPE of that module (`import type`), so no
// Zod or contract values enter the worker bundle; the runtime imports the
// schema VALUES here to build validated handlers. The contract module is the
// single source of truth both ends reference — the host satisfies a published
// interface rather than receiving an implementation co-located with the
// plugin.
//
// Validation runs MAIN-side only (the trust boundary into the host process):
// `args` are parsed before the handler touches any singleton, and the handler
// result is parsed (and MAY be coerced — e.g. BigInt → string) before it
// crosses back to the worker. This change ships the mechanism only; concrete
// host methods (and their contract modules) land with their first consumer.

/** A single method's contract: schemas for its args tuple and its result. */
interface HostMethodContract<
	A extends z.ZodType = z.ZodType,
	R extends z.ZodType = z.ZodType,
> {
	readonly args: A;
	readonly result: R;
}

/**
 * Derive a worker-facing `HostApi` shape from a map of contract modules. The
 * worker imports this TYPE (never the value) to type `ctx.callHost`. Each
 * method becomes `(args) => Promise<result>` keyed by method name.
 */
type HostApiOf<C extends Record<string, HostMethodContract>> = {
	[K in keyof C]: (
		args: z.infer<C[K]["args"]>,
	) => Promise<z.infer<C[K]["result"]>>;
};

/**
 * Wrap a handler with main-side validation and return a single-entry
 * `HostHandlers` map ready to spread into the sandbox's `hostHandlers`.
 *
 * The returned handler parses the raw `args` against the contract before
 * invoking `handler`, then parses (and applies any coercing transforms in)
 * the result before it is posted back. A validation failure rejects the
 * worker-side `callHost` with a `ZodError` (its `.issues` cross the channel).
 */
function defineHostMethod<A extends z.ZodType, R extends z.ZodType>(
	name: string,
	contract: HostMethodContract<A, R>,
	handler: (args: z.infer<A>) => z.input<R> | Promise<z.input<R>>,
): HostHandlers {
	const wrapped: HostHandler = async (rawArgs) => {
		const args = contract.args.parse(rawArgs) as z.infer<A>;
		const out = await handler(args);
		return contract.result.parse(out);
	};
	return { [name]: wrapped };
}

export type { HostApiOf, HostMethodContract };
export { defineHostMethod };
