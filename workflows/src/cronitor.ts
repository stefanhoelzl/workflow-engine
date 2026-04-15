import { createWorkflow, env, http, z } from "@workflow-engine/sdk";

const workflow = createWorkflow("cronitor")
	.trigger(
		"webhook.cronitor",
		http({
			path: "cronitor",
			body: z.object({
				id: z.string().meta({ example: "id" }),
				monitor: z.string().meta({ example: "monitor" }),
				description: z.string().meta({ example: "ALERT" }),
				type: z.enum(["ALERT", "RECOVERY"]),
				rule: z.string().meta({ example: "rule" }),
				environment: z.string().meta({ example: "production" }),
				group: z.string().nullable(),
				issue_url: z
					.string()
					.meta({ example: "https://example.com/issue/abc-123" }),
				monitor_url: z
					.string()
					.meta({ example: "https://example.com/monitor/123" }),
			}),
			response: { status: 202 },
		}),
	)
	.event(
		"notify.message",
		z.object({
			message: z.string(),
		}),
	);

export const handleCronitorEvent = workflow.action({
	on: "webhook.cronitor",
	emits: ["notify.message"],
	handler: async (ctx) => {
		const { body } = ctx.event.payload;
		const emoji = body.type === "ALERT" ? "\u26a0\ufe0f" : "\u2705";
		const label = body.type === "ALERT" ? "Alert" : "Recovery";
		const message = [
			`**${emoji} ${label}: ${body.monitor}**`,
			`Rule: ${body.rule}`,
			`Environment: ${body.environment}`,
			body.issue_url,
		].join("\n");
		await ctx.emit("notify.message", { message });
	},
});

export const sendMessage = workflow.action({
	on: "notify.message",
	env: {
		NEXTCLOUD_URL: env({ default: "https://nextcloud.com" }),
		NEXTCLOUD_TALK_ROOM: env({ default: "abc123" }),
		NEXTCLOUD_USERNAME: env({ default: "max.mustermann" }),
		NEXTCLOUD_APP_PASSWORD: env({ default: "very strong" }),
	},
	handler: async (ctx) => {
		const url = `${ctx.env.NEXTCLOUD_URL}/ocs/v2.php/apps/spreed/api/v1/chat/${ctx.env.NEXTCLOUD_TALK_ROOM}`;
		await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"OCS-APIRequest": "true",
				Authorization: `Basic ${btoa(`${ctx.env.NEXTCLOUD_USERNAME}:${ctx.env.NEXTCLOUD_APP_PASSWORD}`)}`,
			},
			body: JSON.stringify({ message: ctx.event.payload.message }),
		});
	},
});

export default workflow;
