// Type declaration for the `?sandbox-plugin` query suffix handled by
// `sandboxPlugins()` (see design §10). A matching import yields the
// plugin's virtual-module default export shape: `{ name, dependsOn?, source }`.

declare module "*?sandbox-plugin" {
	const plugin: {
		readonly name: string;
		readonly dependsOn?: readonly string[];
		readonly source: string;
	};
	export default plugin;
}
