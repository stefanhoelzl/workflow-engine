import { defineWorkflow, z } from "@workflow-engine/sdk";

const sampleWorkflow = defineWorkflow({
	events: {
		"cronitor.webhook": z.object({
			id: z.string(),
			monitor: z.string(),
			description: z.string(),
			type: z.enum(["ALERT", "RECOVERY"]),
			rule: z.string(),
			environment: z.string(),
			group: z.string().nullable(),
			// biome-ignore lint/style/useNamingConvention: Cronitor API field
			issue_url: z.string(),
			// biome-ignore lint/style/useNamingConvention: Cronitor API field
			monitor_url: z.string(),
		}),
	},
	triggers: {
		cronitor: {
			type: "http",
			path: "cronitor",
			event: "cronitor.webhook",
			response: { status: 202 },
		},
	},
	actions: {
		notifyCronitor: {
			on: "cronitor.webhook",
			env: [
				"NEXTCLOUD_URL",
				"NEXTCLOUD_TALK_ROOM",
				"NEXTCLOUD_USERNAME",
				"NEXTCLOUD_APP_PASSWORD",
			],
			handler: async (ctx) => {
				const payload = ctx.event.payload;
				const emoji = payload.type === "ALERT" ? "\u26a0\ufe0f" : "\u2705";
				const label = payload.type === "ALERT" ? "Alert" : "Recovery";
				const message = [
					`**${emoji} ${label}: ${payload.monitor}**`,
					`Rule: ${payload.rule}`,
					`Environment: ${payload.environment}`,
					payload.issue_url,
				].join("\n");

				const url = `${ctx.env.NEXTCLOUD_URL}/ocs/v2.php/apps/spreed/api/v1/chat/${ctx.env.NEXTCLOUD_TALK_ROOM}`;
				await ctx.fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						// biome-ignore lint/style/useNamingConvention: HTTP header
						Accept: "application/json",
						"OCS-APIRequest": "true",
						// biome-ignore lint/style/useNamingConvention: HTTP header
						Authorization: `Basic ${btoa(`${ctx.env.NEXTCLOUD_USERNAME}:${ctx.env.NEXTCLOUD_APP_PASSWORD}`)}`,
					},
					body: JSON.stringify({ message }),
				});
			},
		},
	},
});

export { sampleWorkflow };
