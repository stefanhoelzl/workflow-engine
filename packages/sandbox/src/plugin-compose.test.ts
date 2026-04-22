import { describe, expect, it } from "vitest";
import type { PluginDescriptor } from "./plugin.js";
import {
	assertGuestFunctionNamesUnique,
	GuestFunctionNameCollisionError,
	PluginConfigSerializationError,
	PluginDependencyCycleError,
	PluginMissingDependencyError,
	PluginNameCollisionError,
	serializePluginDescriptors,
	topoSortPlugins,
} from "./plugin-compose.js";

function d(
	name: string,
	dependsOn: readonly string[] = [],
	config?: unknown,
): PluginDescriptor {
	return {
		name,
		workerSource: `export default () => ({ name: "${name}" });`,
		...(dependsOn.length > 0 ? { dependsOn } : {}),
		...(config === undefined ? {} : { config: config as never }),
	};
}

describe("serializePluginDescriptors — name uniqueness", () => {
	it("accepts unique names", () => {
		const out = serializePluginDescriptors([d("a"), d("b"), d("c")]);
		expect(out.map((x) => x.name)).toEqual(["a", "b", "c"]);
	});

	it("throws on duplicate names", () => {
		expect(() => serializePluginDescriptors([d("a"), d("a")])).toThrow(
			PluginNameCollisionError,
		);
	});
});

describe("serializePluginDescriptors — dependsOn validation", () => {
	it("accepts references to existing plugins", () => {
		const out = serializePluginDescriptors([d("a"), d("b", ["a"])]);
		expect(out).toHaveLength(2);
	});

	it("throws on reference to missing plugin", () => {
		expect(() => serializePluginDescriptors([d("a", ["missing"])])).toThrow(
			PluginMissingDependencyError,
		);
	});

	it("throws on non-string dependsOn entry", () => {
		const bad: PluginDescriptor = {
			name: "a",
			workerSource: "export default () => ({});",
			dependsOn: [42 as unknown as string],
		};
		expect(() => serializePluginDescriptors([bad])).toThrow(TypeError);
	});

	it("throws on non-array dependsOn", () => {
		const bad: PluginDescriptor = {
			name: "a",
			workerSource: "export default () => ({});",
			dependsOn: "x" as unknown as readonly string[],
		};
		expect(() => serializePluginDescriptors([bad])).toThrow(TypeError);
	});
});

describe("serializePluginDescriptors — config serialization", () => {
	it("accepts null, primitives, plain objects, arrays", () => {
		const config = {
			a: 1,
			b: "x",
			c: true,
			d: null,
			e: [1, 2, { f: "y" }],
			g: undefined,
		};
		expect(() =>
			serializePluginDescriptors([d("p", [], config)]),
		).not.toThrow();
	});

	it("rejects functions in config", () => {
		const config = { handler: () => 42 };
		expect(() => serializePluginDescriptors([d("p", [], config)])).toThrow(
			PluginConfigSerializationError,
		);
	});

	it("rejects nested functions with a precise path", () => {
		const config = { deep: { nested: { cb: () => {} } } };
		try {
			serializePluginDescriptors([d("p", [], config)]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(PluginConfigSerializationError);
			const typed = err as PluginConfigSerializationError;
			expect(typed.pluginName).toBe("p");
			expect(typed.path).toEqual(["deep", "nested", "cb"]);
			expect(typed.kind).toBe("function");
		}
	});

	it("rejects class instances", () => {
		class MyClass {
			value = 1;
		}
		expect(() =>
			serializePluginDescriptors([d("p", [], { instance: new MyClass() })]),
		).toThrow(PluginConfigSerializationError);
	});

	it("rejects Date, Map, Set", () => {
		expect(() =>
			serializePluginDescriptors([d("p", [], { d: new Date() })]),
		).toThrow(PluginConfigSerializationError);
		expect(() =>
			serializePluginDescriptors([d("p", [], { m: new Map() })]),
		).toThrow(PluginConfigSerializationError);
		expect(() =>
			serializePluginDescriptors([d("p", [], { s: new Set() })]),
		).toThrow(PluginConfigSerializationError);
	});

	it("rejects symbols and bigints", () => {
		expect(() =>
			serializePluginDescriptors([d("p", [], { s: Symbol("x") })]),
		).toThrow(PluginConfigSerializationError);
		expect(() => serializePluginDescriptors([d("p", [], { b: 1n })])).toThrow(
			PluginConfigSerializationError,
		);
	});

	it("rejects circular references", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		expect(() => serializePluginDescriptors([d("p", [], obj)])).toThrow(
			PluginConfigSerializationError,
		);
	});
});

describe("topoSortPlugins", () => {
	it("orders dependencies before dependents", () => {
		const out = topoSortPlugins([d("c", ["b"]), d("b", ["a"]), d("a")]);
		expect(out.map((p) => p.name)).toEqual(["a", "b", "c"]);
	});

	it("preserves input order among zero-dep peers", () => {
		const out = topoSortPlugins([d("a"), d("b"), d("c")]);
		expect(out.map((p) => p.name)).toEqual(["a", "b", "c"]);
	});

	it("handles diamond dependencies", () => {
		// a -> b -> d
		// a -> c -> d
		const out = topoSortPlugins([
			d("a"),
			d("b", ["a"]),
			d("c", ["a"]),
			d("d", ["b", "c"]),
		]);
		const names = out.map((p) => p.name);
		expect(names.indexOf("a")).toBeLessThan(names.indexOf("b"));
		expect(names.indexOf("a")).toBeLessThan(names.indexOf("c"));
		expect(names.indexOf("b")).toBeLessThan(names.indexOf("d"));
		expect(names.indexOf("c")).toBeLessThan(names.indexOf("d"));
	});

	it("throws on a two-node cycle", () => {
		expect(() => topoSortPlugins([d("a", ["b"]), d("b", ["a"])])).toThrow(
			PluginDependencyCycleError,
		);
	});

	it("throws on a three-node cycle", () => {
		expect(() =>
			topoSortPlugins([d("a", ["c"]), d("b", ["a"]), d("c", ["b"])]),
		).toThrow(PluginDependencyCycleError);
	});

	it("includes the cycle path in the error", () => {
		try {
			topoSortPlugins([d("a", ["b"]), d("b", ["a"])]);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(PluginDependencyCycleError);
			const cycle = (err as PluginDependencyCycleError).cycle;
			expect(cycle.length).toBeGreaterThan(0);
			expect(cycle[0]).toBe(cycle.at(-1));
		}
	});
});

describe("assertGuestFunctionNamesUnique", () => {
	it("accepts unique names across plugins", () => {
		expect(() =>
			assertGuestFunctionNamesUnique([
				{ pluginName: "a", functionName: "setTimeout" },
				{ pluginName: "b", functionName: "fetch" },
			]),
		).not.toThrow();
	});

	it("accepts the same plugin registering its own duplicates (descriptor-level)", () => {
		// Same plugin registering the same name twice is handled elsewhere (would
		// shadow itself); this predicate only guards cross-plugin collisions.
		expect(() =>
			assertGuestFunctionNamesUnique([
				{ pluginName: "a", functionName: "setTimeout" },
				{ pluginName: "a", functionName: "setTimeout" },
			]),
		).not.toThrow();
	});

	it("throws on cross-plugin name collision", () => {
		expect(() =>
			assertGuestFunctionNamesUnique([
				{ pluginName: "a", functionName: "setTimeout" },
				{ pluginName: "b", functionName: "setTimeout" },
			]),
		).toThrow(GuestFunctionNameCollisionError);
	});

	it("error identifies both colliding plugins", () => {
		try {
			assertGuestFunctionNamesUnique([
				{ pluginName: "timers", functionName: "setTimeout" },
				{ pluginName: "mock", functionName: "setTimeout" },
			]);
			expect.fail("should have thrown");
		} catch (err) {
			const typed = err as GuestFunctionNameCollisionError;
			expect(typed.functionName).toBe("setTimeout");
			expect(typed.firstPlugin).toBe("timers");
			expect(typed.secondPlugin).toBe("mock");
		}
	});
});
