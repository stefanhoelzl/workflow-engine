import {
	action,
	defineWorkflow,
	env,
	httpTrigger,
	z,
} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		NEXTCLOUD_URL: env({ default: "https://nextcloud.com" }),
		NEXTCLOUD_TALK_ROOM: env({ default: "talk-room" }),
		NEXTCLOUD_USERNAME: env({ default: "user" }),
		NEXTCLOUD_APP_PASSWORD: env({ default: "password" }),
	},
});

export const sendNotification = action({
	input: z.object({ message: z.string() }),
	output: z.null(),
	handler: async ({ message }) => {
		const auth = btoa(
			`${workflow.env.NEXTCLOUD_USERNAME}:${workflow.env.NEXTCLOUD_APP_PASSWORD}`,
		);
		const url = `${workflow.env.NEXTCLOUD_URL}/ocs/v2.php/apps/spreed/api/v1/chat/${workflow.env.NEXTCLOUD_TALK_ROOM}`;
		await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"OCS-APIRequest": "true",
				Authorization: `Basic ${auth}`,
			},
			body: JSON.stringify({ message }),
		});
		return null;
	},
});

export const cronitorWebhook = httpTrigger({
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
	handler: async ({ body }) => {
		const emoji = body.type === "ALERT" ? "\u26a0\ufe0f" : "\u2705";
		const label = body.type === "ALERT" ? "Alert" : "Recovery";
		const message = [
			`**${emoji} ${label}: ${body.monitor}**`,
			`Rule: ${body.rule}`,
			`Environment: ${body.environment}`,
			body.issue_url,
		].join("\n");
		await sendNotification({ message });
		return { status: 202 };
	},
});
