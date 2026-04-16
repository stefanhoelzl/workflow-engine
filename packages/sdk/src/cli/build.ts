import { build as viteBuild } from "vite";
import { defaultViteConfig } from "./vite-config.js";

class NoWorkflowsFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoWorkflowsFoundError";
	}
}

async function build(options: { cwd: string }): Promise<void> {
	try {
		await viteBuild(defaultViteConfig(options.cwd));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("no workflows found")) {
			throw new NoWorkflowsFoundError(message);
		}
		throw error;
	}
}

export { build, NoWorkflowsFoundError };
