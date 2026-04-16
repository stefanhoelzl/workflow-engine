import type { JSValueHandle } from "quickjs-wasi";
import type { Bridge } from "./bridge-factory.js";

type HostMethod = (...args: unknown[]) => Promise<unknown>;
type MethodMap = Record<string, HostMethod>;

// biome-ignore lint/complexity/useMaxParams: bridge install signature mirrors b.async() — collapsing into options would just shuffle args
function installHostMethod(
	b: Bridge,
	target: JSValueHandle,
	name: string,
	impl: HostMethod,
	methodEventName?: string,
): void {
	b.async(target, name, {
		method: methodEventName ?? name,
		args: [b.arg.json.rest],
		marshal: b.marshal.json,
		impl: async (...args) => impl(...args),
	});
}

function installMethods(
	b: Bridge,
	target: JSValueHandle,
	methods: MethodMap,
): void {
	for (const [name, impl] of Object.entries(methods)) {
		installHostMethod(b, target, name, impl);
	}
}

// biome-ignore lint/complexity/useMaxParams: bridge install signature mirrors b.async() — collapsing into options would just shuffle args
function installRpcMethods(
	b: Bridge,
	target: JSValueHandle,
	names: readonly string[],
	sendRequest: (method: string, args: unknown[]) => Promise<unknown>,
	methodEventNames?: Record<string, string>,
): void {
	for (const name of names) {
		const eventName = methodEventNames?.[name] ?? name;
		b.async(target, name, {
			method: eventName,
			args: [b.arg.json.rest],
			marshal: b.marshal.json,
			impl: async (...args) => sendRequest(name, args),
		});
	}
}

function uninstallGlobals(b: Bridge, names: readonly string[]): void {
	for (const name of names) {
		b.vm.setProp(b.vm.global, name, b.vm.undefined);
	}
}

export type { HostMethod, MethodMap };
export {
	installHostMethod,
	installMethods,
	installRpcMethods,
	uninstallGlobals,
};
