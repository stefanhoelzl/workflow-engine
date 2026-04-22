// Ambient module declarations for vite virtual IDs consumed by the WPT
// harness (`packages/sandbox-stdlib/test/wpt/vitest.config.ts` registers
// `sandboxPlugins()` + `sandboxPolyfills()`).

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
