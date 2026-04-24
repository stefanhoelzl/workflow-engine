import { html } from "hono/html";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	TriggerDescriptor,
} from "../executor/types.js";

// Shared trigger-kind helpers used by both the `/trigger` page and the
// `/dashboard` invocation list. Adding a new trigger kind requires one line
// here in each helper (plus the kind's runtime backend).

const KIND_ICONS: Record<string, string> = {
	http: "\u{1F310}", // globe
	cron: "\u{23F0}", // alarm clock
	manual: "\u{1F464}", // bust in silhouette
};

const KIND_LABELS: Record<string, string> = {
	http: "HTTP",
	cron: "Cron",
	manual: "Manual",
};

function triggerKindIcon(kind: string) {
	const glyph = KIND_ICONS[kind] ?? "\u{25CF}";
	return html`<span class="trigger-kind-icon" title="${kind}" aria-label="${kind}">${glyph}</span>`;
}

function triggerKindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? kind;
}

function triggerCardMeta(
	descriptor: TriggerDescriptor,
	owner: string,
	repo: string,
	workflow: string,
): string {
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		return `${http.method} /webhooks/${owner}/${repo}/${workflow}/${http.name}`;
	}
	if (descriptor.kind === "cron") {
		const cron = descriptor as CronTriggerDescriptor;
		return `${cron.schedule} (${cron.tz})`;
	}
	// manual — no meta line (UI-only fire path, nothing schedule/URL-like to show)
	return "";
}

export { triggerCardMeta, triggerKindIcon, triggerKindLabel };
