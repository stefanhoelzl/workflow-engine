import type { PluginDescriptor, SerializableConfig } from "./plugin.js";

/**
 * Error raised when a PluginDescriptor contains a config value that is not
 * JSON-serializable (functions, class instances, RegExp, etc.). Config must be
 * transferable via structured clone across the worker_threads boundary, so any
 * non-serializable value is rejected at construction time before a worker is
 * spawned.
 */
class PluginConfigSerializationError extends Error {
	readonly pluginName: string;
	readonly path: readonly string[];
	readonly kind: string;

	constructor(pluginName: string, path: readonly string[], kind: string) {
		super(
			`plugin "${pluginName}" config contains non-serializable value at ${formatPath(path)} (${kind})`,
		);
		this.name = "PluginConfigSerializationError";
		this.pluginName = pluginName;
		this.path = path;
		this.kind = kind;
	}
}

class PluginNameCollisionError extends Error {
	readonly name = "PluginNameCollisionError";
	readonly pluginName: string;

	constructor(pluginName: string) {
		super(`plugin name "${pluginName}" is registered more than once`);
		this.pluginName = pluginName;
	}
}

class PluginMissingDependencyError extends Error {
	readonly name = "PluginMissingDependencyError";
	readonly pluginName: string;
	readonly missing: string;

	constructor(pluginName: string, missing: string) {
		super(
			`plugin "${pluginName}" declares dependsOn: "${missing}" but no such plugin is registered`,
		);
		this.pluginName = pluginName;
		this.missing = missing;
	}
}

class PluginDependencyCycleError extends Error {
	readonly name = "PluginDependencyCycleError";
	readonly cycle: readonly string[];

	constructor(cycle: readonly string[]) {
		super(`plugin dependency cycle: ${cycle.join(" -> ")}`);
		this.cycle = cycle;
	}
}

class GuestFunctionNameCollisionError extends Error {
	readonly name = "GuestFunctionNameCollisionError";
	readonly functionName: string;
	readonly firstPlugin: string;
	readonly secondPlugin: string;

	constructor(functionName: string, firstPlugin: string, secondPlugin: string) {
		super(
			`guest function name "${functionName}" is registered by both plugins "${firstPlugin}" and "${secondPlugin}"`,
		);
		this.functionName = functionName;
		this.firstPlugin = firstPlugin;
		this.secondPlugin = secondPlugin;
	}
}

function formatPath(path: readonly string[]): string {
	if (path.length === 0) {
		return "<root>";
	}
	return path.join(".");
}

const FORBIDDEN_KINDS = new Set(["function", "symbol", "bigint"]);

function classifyNonObject(t: string): "primitive" | "forbidden" | "unknown" {
	if (t === "boolean" || t === "number" || t === "string") {
		return "primitive";
	}
	if (FORBIDDEN_KINDS.has(t)) {
		return "forbidden";
	}
	return "unknown";
}

function assertPlainObjectProto(
	pluginName: string,
	path: readonly string[],
	obj: object,
): void {
	const proto = Object.getPrototypeOf(obj) as object | null;
	if (proto === null || proto === Object.prototype) {
		return;
	}
	const ctorName =
		(proto as { constructor?: { name?: string } }).constructor?.name ??
		"non-plain-object";
	throw new PluginConfigSerializationError(pluginName, path, ctorName);
}

function assertArrayElementsSerializable(
	pluginName: string,
	path: readonly string[],
	arr: readonly unknown[],
	seen: WeakSet<object>,
): void {
	for (let i = 0; i < arr.length; i++) {
		assertSerializableConfig(pluginName, arr[i], [...path, String(i)], seen);
	}
}

function assertObjectEntriesSerializable(
	pluginName: string,
	path: readonly string[],
	obj: object,
	seen: WeakSet<object>,
): void {
	for (const key of Object.keys(obj)) {
		assertSerializableConfig(
			pluginName,
			(obj as Record<string, unknown>)[key],
			[...path, key],
			seen,
		);
	}
}

/**
 * Deep-walks a value asserting that every leaf is JSON-serializable. Throws
 * PluginConfigSerializationError on the first non-conforming value. Uses an
 * explicit seen-set to reject circular references (which would JSON.stringify
 * to a TypeError anyway, but we want a typed error with the offending path).
 */
function assertSerializableConfig(
	pluginName: string,
	value: unknown,
	path: readonly string[],
	seen: WeakSet<object>,
): asserts value is SerializableConfig {
	if (value === null || value === undefined) {
		return;
	}
	const t = typeof value;
	const classification = classifyNonObject(t);
	if (classification === "primitive") {
		return;
	}
	if (classification === "forbidden") {
		throw new PluginConfigSerializationError(pluginName, path, t);
	}
	if (t !== "object") {
		throw new PluginConfigSerializationError(pluginName, path, t);
	}
	const obj = value as object;
	if (seen.has(obj)) {
		throw new PluginConfigSerializationError(
			pluginName,
			path,
			"circular-reference",
		);
	}
	seen.add(obj);
	if (Array.isArray(obj)) {
		assertArrayElementsSerializable(pluginName, path, obj, seen);
		return;
	}
	assertPlainObjectProto(pluginName, path, obj);
	assertObjectEntriesSerializable(pluginName, path, obj, seen);
}

function validateDependsOn(descriptor: PluginDescriptor): void {
	if (descriptor.dependsOn === undefined) {
		return;
	}
	if (!Array.isArray(descriptor.dependsOn)) {
		throw new TypeError(
			`plugin "${descriptor.name}" dependsOn must be an array of plugin names`,
		);
	}
	for (const dep of descriptor.dependsOn) {
		if (typeof dep !== "string" || dep.length === 0) {
			throw new TypeError(
				`plugin "${descriptor.name}" dependsOn entries must be non-empty strings`,
			);
		}
	}
}

/**
 * Validates a single plugin descriptor's shape: non-empty name + workerSource,
 * optional guestSource is a string (when present), optional dependsOn is an
 * array of non-empty strings, and config is deeply JSON-serializable. Throws
 * on any violation before the worker is spawned.
 */
function validateDescriptor(descriptor: PluginDescriptor): void {
	if (typeof descriptor.name !== "string" || descriptor.name.length === 0) {
		throw new TypeError("plugin descriptor must have a non-empty name");
	}
	if (
		typeof descriptor.workerSource !== "string" ||
		descriptor.workerSource.length === 0
	) {
		throw new TypeError(
			`plugin "${descriptor.name}" must have a non-empty workerSource`,
		);
	}
	if (
		descriptor.guestSource !== undefined &&
		(typeof descriptor.guestSource !== "string" ||
			descriptor.guestSource.length === 0)
	) {
		throw new TypeError(
			`plugin "${descriptor.name}" guestSource, when present, must be a non-empty string`,
		);
	}
	validateDependsOn(descriptor);
	if (descriptor.config !== undefined) {
		assertSerializableConfig(
			descriptor.name,
			descriptor.config,
			[],
			new WeakSet(),
		);
	}
}

/**
 * Serializes an array of plugin descriptors for transfer to the worker via
 * postMessage. Performs all validation up-front so any failure surfaces before
 * the worker is spawned: (1) descriptor shape, (2) JSON-serializable config,
 * (3) name uniqueness, (4) dependsOn references existing plugins.
 *
 * The returned array is structured-clone safe and can be posted as-is.
 */
function serializePluginDescriptors(
	descriptors: readonly PluginDescriptor[],
): readonly PluginDescriptor[] {
	const seenNames = new Set<string>();
	for (const d of descriptors) {
		validateDescriptor(d);
		if (seenNames.has(d.name)) {
			throw new PluginNameCollisionError(d.name);
		}
		seenNames.add(d.name);
	}
	for (const d of descriptors) {
		if (d.dependsOn === undefined) {
			continue;
		}
		for (const dep of d.dependsOn) {
			if (!seenNames.has(dep)) {
				throw new PluginMissingDependencyError(d.name, dep);
			}
		}
	}
	// Freeze a shallow copy so callers can't mutate post-validation.
	return descriptors.map((d) => Object.freeze({ ...d }));
}

interface TopoState {
	readonly byName: Map<string, PluginDescriptor>;
	readonly pendingDeps: Map<string, Set<string>>;
	readonly dependents: Map<string, string[]>;
}

function buildTopoState(descriptors: readonly PluginDescriptor[]): TopoState {
	const byName = new Map<string, PluginDescriptor>();
	const pendingDeps = new Map<string, Set<string>>();
	const dependents = new Map<string, string[]>();
	for (const d of descriptors) {
		byName.set(d.name, d);
		pendingDeps.set(d.name, new Set(d.dependsOn ?? []));
		dependents.set(d.name, []);
	}
	for (const d of descriptors) {
		for (const dep of d.dependsOn ?? []) {
			const list = dependents.get(dep);
			if (list) {
				list.push(d.name);
			}
		}
	}
	return { byName, pendingDeps, dependents };
}

function initialReadyQueue(
	descriptors: readonly PluginDescriptor[],
	pendingDeps: Map<string, Set<string>>,
): string[] {
	const ready: string[] = [];
	for (const d of descriptors) {
		const pend = pendingDeps.get(d.name);
		if (pend && pend.size === 0) {
			ready.push(d.name);
		}
	}
	return ready;
}

/**
 * Topologically sorts plugin descriptors by `dependsOn`. Plugins with no
 * dependencies come first; each subsequent plugin appears after all of its
 * declared dependencies. Within a dependency tier, order is stable (matches
 * the input order among peers) so test compositions remain deterministic.
 *
 * Throws PluginDependencyCycleError if a cycle exists. Assumes descriptors
 * have been pre-validated by `serializePluginDescriptors` (names unique,
 * dependsOn references existing plugins).
 */
function topoSortPlugins(
	descriptors: readonly PluginDescriptor[],
): readonly PluginDescriptor[] {
	const { byName, pendingDeps, dependents } = buildTopoState(descriptors);
	const ready = initialReadyQueue(descriptors, pendingDeps);
	const ordered: PluginDescriptor[] = [];
	while (ready.length > 0) {
		const current = ready.shift();
		if (current === undefined) {
			break;
		}
		const descriptor = byName.get(current);
		if (descriptor !== undefined) {
			ordered.push(descriptor);
		}
		for (const dependent of dependents.get(current) ?? []) {
			const pend = pendingDeps.get(dependent);
			if (pend === undefined) {
				continue;
			}
			pend.delete(current);
			if (pend.size === 0) {
				ready.push(dependent);
			}
		}
	}
	if (ordered.length !== descriptors.length) {
		// Cycle detected — reconstruct a representative cycle for the error.
		const cycle = findCycle(descriptors, pendingDeps);
		throw new PluginDependencyCycleError(cycle);
	}
	return ordered;
}

function findCycle(
	descriptors: readonly PluginDescriptor[],
	pendingDeps: Map<string, Set<string>>,
): readonly string[] {
	// Walk any node that still has pending deps, following dep edges until we
	// revisit a node — that path is a cycle witness.
	const remaining = descriptors.filter(
		(d) => (pendingDeps.get(d.name)?.size ?? 0) > 0,
	);
	if (remaining.length === 0) {
		return [];
	}
	const start = remaining[0];
	if (!start) {
		return [];
	}
	const visited = new Set<string>();
	const path: string[] = [];
	let current: string | undefined = start.name;
	while (current !== undefined) {
		if (visited.has(current)) {
			const cycleStart = path.indexOf(current);
			return [...path.slice(cycleStart), current];
		}
		visited.add(current);
		path.push(current);
		const deps = pendingDeps.get(current);
		const next = deps ? [...deps][0] : undefined;
		current = next;
	}
	return path;
}

/**
 * Given the ordered list of guest functions a plugin registered (keyed by
 * plugin name), detects name collisions across plugins. Registering two guest
 * functions with the same name from different plugins is an authoring error
 * — the second would shadow the first on globalThis silently.
 *
 * Accepts entries as `{ pluginName, functionName }` pairs so callers can
 * assemble them from PluginSetup.guestFunctions without requiring a specific
 * container shape.
 */
function assertGuestFunctionNamesUnique(
	entries: ReadonlyArray<{
		readonly pluginName: string;
		readonly functionName: string;
	}>,
): void {
	const firstOccurrence = new Map<string, string>();
	for (const { pluginName, functionName } of entries) {
		const prior = firstOccurrence.get(functionName);
		if (prior !== undefined && prior !== pluginName) {
			throw new GuestFunctionNameCollisionError(
				functionName,
				prior,
				pluginName,
			);
		}
		if (prior === undefined) {
			firstOccurrence.set(functionName, pluginName);
		}
	}
}

export {
	assertGuestFunctionNamesUnique,
	assertSerializableConfig,
	GuestFunctionNameCollisionError,
	PluginConfigSerializationError,
	PluginDependencyCycleError,
	PluginMissingDependencyError,
	PluginNameCollisionError,
	serializePluginDescriptors,
	topoSortPlugins,
};
