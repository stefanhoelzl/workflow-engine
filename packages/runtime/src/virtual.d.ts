// Ambient module declarations for vite virtual IDs consumed by runtime.
// The `sandboxPlugins()` vite plugin handles `?sandbox-plugin` queries.

declare module "*?sandbox-plugin" {
	const plugin: {
		readonly name: string;
		readonly dependsOn?: readonly string[];
		readonly workerSource: string;
		readonly guestSource?: string;
	};
	export default plugin;
}
