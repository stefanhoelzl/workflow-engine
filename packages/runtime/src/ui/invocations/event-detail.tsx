import type { InvocationEvent } from "@workflow-engine/core";

function bigintReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? Number(value) : value;
}

function EventDetail({ event }: { event: InvocationEvent }) {
	const json = JSON.stringify(event, bigintReplacer);
	return (
		<div class="event-detail-fragment">
			<article class="event-detail" x-data="wfeJsonTree" data-json={json}>
				<div class="event-detail-tree" data-json-tree-mount={true} />
			</article>
		</div>
	);
}

function renderEventDetail(event: InvocationEvent): string {
	return (<EventDetail event={event} />).toString();
}

export { EventDetail, renderEventDetail };
