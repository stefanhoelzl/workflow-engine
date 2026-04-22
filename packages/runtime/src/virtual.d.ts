// Ambient module declarations for vite virtual IDs consumed by runtime.
// The `sandboxPlugins()` vite plugin handles `?sandbox-plugin` queries;
// the `sandboxPolyfills()` vite plugin handles `virtual:sandbox-polyfills`.
// Both are registered in `packages/runtime/vite.config.ts` and the
// top-level `vitest.config.ts`.

declare module "virtual:sandbox-polyfills" {
	const source: string;
	export default source;
}

declare module "*?sandbox-plugin" {
	const plugin: {
		readonly name: string;
		readonly dependsOn?: readonly string[];
		readonly source: string;
	};
	export default plugin;
}
