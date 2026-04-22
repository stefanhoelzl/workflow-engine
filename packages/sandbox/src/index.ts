// Public package entry. Pure re-export barrel — keeps factory.ts from cycling
// on the module that hosts `sandbox()` (which it consumes as a value).

export type { FactoryCreateOptions, SandboxFactory } from "./factory.js";
// biome-ignore lint/performance/noBarrelFile: public package entry surfaces the factory alongside sandbox(), intentionally a single module
export { createSandboxFactory } from "./factory.js";
export type {
	Callable,
	DepsMap,
	EmitOptions,
	EventExtra,
	EventKind,
	GuestFunctionDescription,
	GuestFunctionHandler,
	LogConfig,
	Plugin,
	PluginDescriptor,
	PluginSetup,
	RunInput,
	RunResult as PluginRunResult,
	SandboxContext,
	SerializableConfig,
	WasiClockArgs,
	WasiClockResult,
	WasiFdWriteArgs,
	WasiHooks,
	WasiRandomArgs,
	WasiRandomResult,
} from "./plugin.js";
export type {
	ArgSpec,
	ArgTypes,
	GuestValue,
	ResultSpec,
	ResultType,
} from "./plugin-types.js";
export { Guest } from "./plugin-types.js";
export { name as WASI_PLUGIN_NAME } from "./plugins/wasi-plugin.js";
export type { Logger, RunResult, Sandbox, SandboxOptions } from "./sandbox.js";
export { sandbox } from "./sandbox.js";
export type { LifecycleError } from "./sandbox-context.js";
export { serializeLifecycleError } from "./sandbox-context.js";
export { withPluginSandbox, withStagedGlobals } from "./test-harness.js";
