// Type declaration for the `?sandbox-plugin` query suffix handled by
// `sandboxPlugins()`. A matching import yields the plugin's virtual-module
// default export shape: `{ name, dependsOn?, workerSource, guestSource? }`.

declare module "*?sandbox-plugin" {
	const plugin: {
		readonly name: string;
		readonly dependsOn?: readonly string[];
		readonly workerSource: string;
		readonly guestSource?: string;
	};
	export default plugin;
}
