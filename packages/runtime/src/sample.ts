import type { Action } from "./actions/index.js";
import type { HttpTriggerDefinition } from "./triggers/index.js";

interface CronitorPayload {
	id: string;
	monitor: string;
	description: string;
	type: "ALERT" | "RECOVERY";
	rule: string;
	environment: string;
	group: string | null;
	// biome-ignore lint/style/useNamingConvention: Cronitor API field
	issue_url: string;
	// biome-ignore lint/style/useNamingConvention: Cronitor API field
	monitor_url: string;
}

function formatMessage(payload: CronitorPayload): string {
	const emoji = payload.type === "ALERT" ? "\u26a0\ufe0f" : "\u2705";
	const label = payload.type === "ALERT" ? "Alert" : "Recovery";
	const lines = [
		`**${emoji} ${label}: ${payload.monitor}**`,
		`Rule: ${payload.rule}`,
		`Environment: ${payload.environment}`,
		payload.issue_url,
	];
	return lines.join("\n");
}

export const sampleTriggers: HttpTriggerDefinition[] = [
	{
		path: "cronitor",
		method: "POST",
		event: "cronitor.webhook",
		response: { status: 202, body: { accepted: true } },
	},
];

export const sampleActions: Action[] = [
	{
		name: "notifyCronitor",
		match: (e) =>
			e.type === "cronitor.webhook" && e.targetAction === "notifyCronitor",
		handler: async (ctx) => {
			const payload = ctx.event.payload as CronitorPayload;
			const message = formatMessage(payload);

			const url = `${ctx.env.NEXTCLOUD_URL}/ocs/v2.php/apps/spreed/api/v4/chat/${ctx.env.NEXTCLOUD_TALK_ROOM}`;
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
];
