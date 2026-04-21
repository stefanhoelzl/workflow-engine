import { action, cronTrigger, defineWorkflow, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow();

export const recordBeat = action({
	input: z.object({ at: z.string() }),
	output: z.null(),
	handler: async (_input) => {
		await Promise.resolve();
		return null;
	},
});

// tz omitted on purpose — the SDK factory resolves the build host's IANA
// zone and the vite-plugin captures it in the manifest.
export const everyMinute = cronTrigger({
	schedule: "* * * * *",
	handler: async () => {
		await recordBeat({ at: new Date().toISOString() });
	},
});

// Explicit tz for a daily digest at 09:00 Berlin.
export const daily = cronTrigger({
	schedule: "0 9 * * *",
	tz: "Europe/Berlin",
	handler: async () => {
		await recordBeat({ at: new Date().toISOString() });
	},
});
