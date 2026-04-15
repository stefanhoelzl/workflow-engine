#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { NoWorkflowsFoundError } from "./build.js";
import { upload } from "./upload.js";

const DEFAULT_URL = "https://workflow-engine.webredirect.org";

const uploadCommand = defineCommand({
	meta: {
		name: "upload",
		description: "Build workflows in cwd and upload them to a runtime",
	},
	args: {
		url: {
			type: "string",
			description: "Target runtime URL",
			default: DEFAULT_URL,
		},
	},
	async run({ args }) {
		try {
			const { failed } = await upload({
				cwd: process.cwd(),
				url: args.url,
			});
			process.exit(failed === 0 ? 0 : 1);
		} catch (error) {
			if (error instanceof NoWorkflowsFoundError) {
				// biome-ignore lint/suspicious/noConsole: user-facing CLI output
				console.error("no workflows found in src/");
				process.exit(1);
			}
			// biome-ignore lint/suspicious/noConsole: user-facing CLI output
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	},
});

const main = defineCommand({
	meta: {
		name: "wfe",
		version: "0.1.0",
		description: "workflow-engine CLI",
	},
	subCommands: {
		upload: uploadCommand,
	},
});

runMain(main);
