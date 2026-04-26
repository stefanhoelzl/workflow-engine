import { afterAll, beforeAll, describe as vitestDescribe } from "vitest";
import { type SpawnedChild, spawnRuntime } from "./spawn.js";
import type { AppHandle } from "./types.js";

interface DescribeOpts {
	env?: Record<string, string>;
	// Per-describe build env injected into every fixture's host env at build
	// time — used by test #14 to thread `GREETING=hello-from-cli` into the
	// fixture without baking the value into the source string.
	buildEnv?: Record<string, string>;
}

interface DescribeContext {
	getChild(): SpawnedChild;
	getBuildEnv(): Record<string, string>;
}

let activeContext: DescribeContext | null = null;

function getActiveContext(): DescribeContext {
	if (!activeContext) {
		throw new Error(
			"e2e: test() called outside of describe(); the test framework requires a describe() wrapper to spawn the runtime",
		);
	}
	return activeContext;
}

function describe(name: string, body: (app: AppHandle) => void): void;
function describe(
	name: string,
	opts: DescribeOpts,
	body: (app: AppHandle) => void,
): void;
function describe(
	name: string,
	optsOrBody: DescribeOpts | ((app: AppHandle) => void),
	maybeBody?: (app: AppHandle) => void,
): void {
	const opts: DescribeOpts = typeof optsOrBody === "function" ? {} : optsOrBody;
	const body =
		typeof optsOrBody === "function"
			? optsOrBody
			: (maybeBody as (app: AppHandle) => void);

	vitestDescribe(name, () => {
		let child: SpawnedChild | null = null;
		const app: AppHandle = {
			get baseUrl(): string {
				if (!child) {
					throw new Error("app.baseUrl read before runtime spawn completed");
				}
				return child.baseUrl;
			},
		};

		// `buildEnv` is hermetic: it travels via `getActiveContext()` to the
		// scenario, which forwards it to `build({env})` and `upload({env})`.
		// The IIFE-eval VM sees only what the describe declared — no leak of
		// the runner's `process.env`, and no mutation of the runner.
		beforeAll(async () => {
			child = await spawnRuntime({ env: opts.env ?? {} });
			activeContext = {
				getChild: () => {
					if (!child) {
						throw new Error("runtime not spawned");
					}
					return child;
				},
				getBuildEnv: () => opts.buildEnv ?? {},
			};
		});

		afterAll(async () => {
			activeContext = null;
			if (child) {
				await child.stop();
				child = null;
			}
		});

		body(app);
	});
}

export type { DescribeContext };
export { describe, getActiveContext };
