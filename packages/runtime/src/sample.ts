import type { Action } from "./actions/index.js";
import type { HttpTriggerDefinition } from "./triggers/index.js";

function requireEnv(name: string): string {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const nextcloudUrl = requireEnv("NEXTCLOUD_URL");
const nextcloudUsername = requireEnv("NEXTCLOUD_USERNAME");
const nextcloudAppPassword = requireEnv("NEXTCLOUD_APP_PASSWORD");
const nextcloudTalkRoom = requireEnv("NEXTCLOUD_TALK_ROOM");

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

			const url = `${nextcloudUrl}/ocs/v2.php/apps/spreed/api/v4/chat/${nextcloudTalkRoom}`;
			await ctx.fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					// biome-ignore lint/style/useNamingConvention: HTTP header
					Accept: "application/json",
					"OCS-APIRequest": "true",
					// biome-ignore lint/style/useNamingConvention: HTTP header
					Authorization: `Basic ${btoa(`${nextcloudUsername}:${nextcloudAppPassword}`)}`,
				},
				body: JSON.stringify({ message }),
			});
		},
	},
];
