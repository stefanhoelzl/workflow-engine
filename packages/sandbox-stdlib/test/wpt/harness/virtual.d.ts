// Ambient module declarations for vite virtual IDs consumed by the WPT
// harness (`packages/sandbox-stdlib/test/wpt/vitest.config.ts` registers
// `sandboxPlugins()`).

declare module "*?sandbox-plugin" {
	const plugin: {
		readonly name: string;
		readonly dependsOn?: readonly string[];
		readonly workerSource: string;
		readonly guestSource?: string;
	};
	export default plugin;
}
