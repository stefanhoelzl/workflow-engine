// Public package entry. Pure re-export barrel — keeps factory.ts from cycling
// on the module that hosts `sandbox()` (which it consumes as a value).

export type {
	FactoryCreateOptions,
	SandboxFactory,
	SandboxResourceLimits,
} from "./factory.js";
// biome-ignore lint/performance/noBarrelFile: public package entry surfaces the factory alongside sandbox(), intentionally a single module
export { createSandboxFactory } from "./factory.js";
export {
	BridgeError,
	GuestArgTypeMismatchError,
	GuestSafeError,
	GuestThrownError,
	GuestValidationError,
} from "./guest-errors.js";
export type { Logger } from "./logger.js";
export type {
	Callable,
	CallId,
	DepsMap,
	EmitFraming,
	EmitOptions,
	EventKind,
	GuestFunctionDescription,
	GuestFunctionHandler,
	LifecycleError,
	LogConfig,
	Plugin,
	PluginContext,
	PluginDescriptor,
	PluginSetup,
	RequestOptions,
	RunInput,
	RunResult as PluginRunResult,
	SerializableConfig,
	WasiClockArgs,
	WasiClockResult,
	WasiFdWriteArgs,
	WasiHooks,
	WasiRandomArgs,
	WasiRandomResult,
} from "./plugin.js";
export { serializeLifecycleError } from "./plugin.js";
export type {
	ArgSpec,
	ArgTypes,
	GuestValue,
	ResultSpec,
	ResultType,
} from "./plugin-types.js";
export { Guest } from "./plugin-types.js";
export { name as WASI_PLUGIN_NAME } from "./plugins/wasi-plugin.js";
export type { WorkerToMain } from "./protocol.js";
export type {
	EmittedEvent,
	FlatEvent,
	FlatRequest,
	RecordedRequest,
	RecordingContext,
	RecordingContextOptions,
} from "./recording-context.js";
export { recordingContext } from "./recording-context.js";
export type { RunResult, Sandbox, SandboxOptions } from "./sandbox.js";
export { sandbox } from "./sandbox.js";
export { withPluginSandbox, withStagedGlobals } from "./test-harness.js";
export type {
	LimitDim,
	TerminationCause,
	WorkerTermination,
} from "./worker-termination.js";
export { SANDBOX_LIMIT_ERROR_NAME } from "./worker-termination.js";
