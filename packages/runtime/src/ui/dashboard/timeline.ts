import type { TimelineEvent } from "./queries.js";

interface LayoutNode {
	event: TimelineEvent;
	x: number;
	y: number;
	children: LayoutNode[];
}

const NODE_SPACING_X = 200;
const BRANCH_SPACING_Y = 50;
const PADDING_X = 80;
const PADDING_TOP = 40;
const LABEL_OFFSET_Y = 24;
const EVENT_RADIUS = 8;
const PILL_HEIGHT = 28;
const PILL_DOT_RADIUS = 5;
const PILL_PADDING_X = 14;
const PILL_DOT_GAP = 8;
const CHAR_WIDTH = 7.2;
const MAX_ACTION_CHARS = 22;
const MIN_PILL_WIDTH = 80;
const EDGE_CONTROL_POINT_RATIO = 0.4;
const HEIGHT_BOTTOM_PADDING = 50;
const TEXT_VERTICAL_OFFSET = 4;
const TIME_SLICE_END = 8;
const TIME_PATTERN = /\d{2}:\d{2}:\d{2}/;

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function buildTree(events: TimelineEvent[]): LayoutNode[] {
	const nodesById = new Map<string, LayoutNode>();
	const roots: LayoutNode[] = [];

	for (const event of events) {
		nodesById.set(event.id, { event, x: 0, y: 0, children: [] });
	}

	for (const event of events) {
		// biome-ignore lint/style/noNonNullAssertion: node was just created above
		const node = nodesById.get(event.id)!;
		if (event.parentEventId && nodesById.has(event.parentEventId)) {
			// biome-ignore lint/style/noNonNullAssertion: checked by has() above
			nodesById.get(event.parentEventId)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	return roots;
}

function assignPositions(roots: LayoutNode[]): {
	width: number;
	height: number;
} {
	let col = 0;
	let maxY = 0;

	function layoutSubtree(node: LayoutNode, baseY: number): void {
		node.x = PADDING_X + col * NODE_SPACING_X;
		col++;

		if (node.children.length === 0) {
			node.y = baseY;
			maxY = Math.max(maxY, node.y);
			return;
		}

		if (node.children.length === 1) {
			node.y = baseY;
			// biome-ignore lint/style/noNonNullAssertion: length check above
			layoutSubtree(node.children[0]!, baseY);
			maxY = Math.max(maxY, node.y);
			return;
		}

		const totalSpan = (node.children.length - 1) * BRANCH_SPACING_Y;
		const startY = baseY - totalSpan / 2;
		node.y = baseY;

		for (let i = 0; i < node.children.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: index within bounds
			layoutSubtree(node.children[i]!, startY + i * BRANCH_SPACING_Y);
		}
		maxY = Math.max(maxY, node.y);
	}

	const centerY = PADDING_TOP + 60;
	for (const root of roots) {
		layoutSubtree(root, centerY);
	}

	const width = PADDING_X * 2 + col * NODE_SPACING_X;
	const height = maxY + LABEL_OFFSET_Y + HEIGHT_BOTTOM_PADDING;

	return { width, height };
}

function displayState(event: TimelineEvent): string {
	if (event.state === "done" && event.result) {
		return event.result === "succeeded" ? "done" : event.result;
	}
	return event.state;
}

function stateColor(state: string): string {
	switch (state) {
		case "done":
			return "var(--green)";
		case "pending":
		case "processing":
			return "var(--yellow)";
		case "failed":
			return "var(--red)";
		case "skipped":
			return "none";
		default:
			return "var(--grey)";
	}
}

function stateBorderColor(state: string): string {
	switch (state) {
		case "done":
			return "var(--green-border)";
		case "pending":
		case "processing":
			return "var(--yellow-border)";
		case "failed":
			return "var(--red-border)";
		default:
			return "var(--grey)";
	}
}

function stateColorName(state: string): string {
	switch (state) {
		case "done":
			return "green";
		case "pending":
		case "processing":
			return "yellow";
		case "failed":
			return "red";
		default:
			return "grey";
	}
}

function renderEdge(parent: LayoutNode, child: LayoutNode): string {
	const dx = child.x - parent.x;
	const cp = dx * EDGE_CONTROL_POINT_RATIO;
	return `<path d="M ${parent.x} ${parent.y} C ${parent.x + cp} ${parent.y}, ${child.x - cp} ${child.y}, ${child.x} ${child.y}" class="edge-line"/>`;
}

function formatTimestamp(value: string | Date): string {
	if ((value as unknown) instanceof Date) {
		return (
			(value as unknown as Date)
				.toISOString()
				.split("T")[1]
				?.slice(0, TIME_SLICE_END) ?? String(value)
		);
	}
	const s = String(value);
	const match = s.match(TIME_PATTERN);
	return match ? match[0] : (s.split("T")[1]?.slice(0, TIME_SLICE_END) ?? s);
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function buildTipJson(e: TimelineEvent, colorName: string, ds: string): string {
	const fullEvent: Record<string, unknown> = {
		id: e.id,
		type: e.type,
		state: ds,
		correlationId: e.correlationId,
		parentEventId: e.parentEventId,
		targetAction: e.targetAction,
		createdAt: formatTimestamp(e.createdAt),
		payload: typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload,
	};
	if (e.error) {
		fullEvent.error =
			typeof e.error === "string"
				? e.error
				: JSON.parse(JSON.stringify(e.error));
	}
	return escapeHtml(
		JSON.stringify({
			type: e.type,
			state: ds,
			color: colorName,
			event: JSON.stringify(fullEvent, null, 2),
		}),
	);
}

function renderEventNode(
	node: LayoutNode,
	tipJson: string,
	ds: string,
): string {
	const e = node.event;
	const fill = stateColor(ds);
	const isSkipped = ds === "skipped";

	const circleAttrs = isSkipped
		? `fill="none" stroke="var(--grey)" stroke-width="2"`
		: `fill="${fill}"`;

	return `<g class="node"
     data-tip="${tipJson}"
     @mouseenter="clearTimeout(_tipTimer); let r = $el.getBoundingClientRect(); tip = JSON.parse($el.getAttribute('data-tip')); tipX = r.left + r.width/2 - 140; tipY = r.bottom + 8"
     @mouseleave="_tipTimer = setTimeout(() => tip = null, 100)">
    <circle cx="${node.x}" cy="${node.y}" r="${EVENT_RADIUS}" ${circleAttrs} class="node-circle"/>
    <text x="${node.x}" y="${node.y + LABEL_OFFSET_Y}" text-anchor="middle" class="node-label">${escapeHtml(e.type)}</text>
  </g>`;
}

function renderActionNode(
	node: LayoutNode,
	tipJson: string,
	ds: string,
): string {
	const e = node.event;
	const actionName = e.targetAction ?? "";
	const displayName = truncate(actionName, MAX_ACTION_CHARS);
	const textWidth = displayName.length * CHAR_WIDTH;
	const pillWidth = Math.max(
		MIN_PILL_WIDTH,
		PILL_PADDING_X +
			PILL_DOT_RADIUS * 2 +
			PILL_DOT_GAP +
			textWidth +
			PILL_PADDING_X,
	);
	const pillX = node.x - pillWidth / 2;
	const pillY = node.y - PILL_HEIGHT / 2;
	const dotCx = pillX + PILL_PADDING_X + PILL_DOT_RADIUS;
	const textX = dotCx + PILL_DOT_RADIUS + PILL_DOT_GAP;

	const fill = stateColor(ds);
	const border = stateBorderColor(ds);
	const isSkipped = ds === "skipped";

	const dotAttrs = isSkipped
		? `fill="none" stroke="var(--grey)" stroke-width="1.5"`
		: `fill="${fill}"`;

	const rectStroke = isSkipped
		? `stroke="var(--grey)" stroke-width="1" stroke-dasharray="4"`
		: `stroke="${border}" stroke-width="1.5"`;

	return `<g class="node"
     data-tip="${tipJson}"
     @mouseenter="clearTimeout(_tipTimer); let r = $el.getBoundingClientRect(); tip = JSON.parse($el.getAttribute('data-tip')); tipX = r.left + r.width/2 - 140; tipY = r.bottom + 8"
     @mouseleave="_tipTimer = setTimeout(() => tip = null, 100)">
    <rect x="${pillX}" y="${pillY}" width="${pillWidth}" height="${PILL_HEIGHT}" rx="${PILL_HEIGHT / 2}" fill="var(--bg-surface)" ${rectStroke}/>
    <circle cx="${dotCx}" cy="${node.y}" r="${PILL_DOT_RADIUS}" ${dotAttrs}/>
    <text x="${textX}" y="${node.y + TEXT_VERTICAL_OFFSET}" text-anchor="start" class="node-action">${escapeHtml(displayName)}</text>
  </g>`;
}

function renderNode(node: LayoutNode): string {
	const e = node.event;
	const ds = displayState(e);
	const colorName = stateColorName(ds);
	const tipJson = buildTipJson(e, colorName, ds);

	if (e.targetAction) {
		return renderActionNode(node, tipJson, ds);
	}
	return renderEventNode(node, tipJson, ds);
}

function collectNodes(node: LayoutNode): LayoutNode[] {
	const result: LayoutNode[] = [node];
	for (const child of node.children) {
		result.push(...collectNodes(child));
	}
	return result;
}

function renderTimeline(events: TimelineEvent[]): string {
	if (events.length === 0) {
		return `<div class="empty-state">No events found.</div>`;
	}

	const roots = buildTree(events);
	const { width, height } = assignPositions(roots);

	const allNodes = roots.flatMap(collectNodes);
	const edges: string[] = [];
	for (const node of allNodes) {
		for (const child of node.children) {
			edges.push(renderEdge(node, child));
		}
	}

	const nodesSvg = allNodes.map(renderNode);

	return `<svg class="timeline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Event timeline">
  ${edges.join("\n  ")}
  ${nodesSvg.join("\n  ")}
</svg>`;
}

export type { LayoutNode };
export { assignPositions, buildTree, renderTimeline };
