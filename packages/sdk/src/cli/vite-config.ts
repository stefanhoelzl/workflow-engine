import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InlineConfig } from "vite";
import { workflowPlugin } from "../plugin/index.js";

function discoverWorkflows(root: string): string[] {
	const workflows: string[] = [];
	const srcDir = join(root, "src");
	let entries: string[];
	try {
		entries = readdirSync(srcDir);
	} catch {
		return workflows;
	}
	for (const entry of entries) {
		if (
			entry.endsWith(".ts") &&
			!entry.endsWith(".test.ts") &&
			!entry.endsWith(".d.ts")
		) {
			const full = join(srcDir, entry);
			if (statSync(full).isFile()) {
				workflows.push(`./src/${entry}`);
			}
		}
	}
	return workflows;
}

function defaultViteConfig(root: string): InlineConfig {
	const workflows = discoverWorkflows(root);
	if (workflows.length === 0) {
		throw new Error(`no workflows found in ${join(root, "src")}`);
	}
	return {
		root,
		configFile: false,
		logLevel: "warn",
		plugins: [workflowPlugin({ workflows })],
	};
}

export { defaultViteConfig };
