import { workflowPlugin } from "@workflow-engine/vite-plugin";
import type { InlineConfig } from "vite";

function defaultViteConfig(root: string): InlineConfig {
	return {
		root,
		configFile: false,
		logLevel: "warn",
		plugins: [workflowPlugin()],
	};
}

export { defaultViteConfig };
