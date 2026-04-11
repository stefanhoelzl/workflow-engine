import { escapeToBuffer } from "hono/utils/html";

function escapeHtml(str: string): string {
	const buffer: [string] = [""];
	escapeToBuffer(str, buffer);
	return buffer[0];
}

export { escapeHtml };
