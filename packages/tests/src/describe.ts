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

		// describe-level `buildEnv` is applied to the parent process for the
		// lifetime of the spawned child. The SDK's `buildWorkflows` (used by
		// both `build()` and `bundle()` during upload) reads `process.env`
		// inside its IIFE-eval VM context to resolve `env()` bindings; routing
		// through `process.env` is the simplest way to thread per-test values
		// without altering the public CLI signature.
		const restored: Record<string, string | undefined> = {};

		beforeAll(async () => {
			for (const [key, value] of Object.entries(opts.buildEnv ?? {})) {
				restored[key] = process.env[key];
				process.env[key] = value;
			}
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
			for (const [key, prev] of Object.entries(restored)) {
				if (prev === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = prev;
				}
			}
		});

		body(app);
	});
}

export type { DescribeContext };
export { describe, getActiveContext };
