import type { QuickJSHandle } from "quickjs-emscripten";
import type { Bridge } from "./bridge-factory.js";

type HostMethod = (...args: unknown[]) => Promise<unknown>;
type MethodMap = Record<string, HostMethod>;

function installHostMethod(
	b: Bridge,
	target: QuickJSHandle,
	name: string,
	impl: HostMethod,
): void {
	b.async(target, name, {
		method: name,
		args: [b.arg.json.rest],
		marshal: b.marshal.json,
		impl: async (...args) => impl(...args),
	});
}

function installMethods(
	b: Bridge,
	target: QuickJSHandle,
	methods: MethodMap,
): void {
	for (const [name, impl] of Object.entries(methods)) {
		installHostMethod(b, target, name, impl);
	}
}

function uninstallGlobals(b: Bridge, names: readonly string[]): void {
	for (const name of names) {
		b.vm.setProp(b.vm.global, name, b.vm.undefined);
	}
}

export type { HostMethod, MethodMap };
export { installHostMethod, installMethods, uninstallGlobals };
