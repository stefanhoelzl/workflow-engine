import { Hono } from "hono";
import { html } from "hono/html";
import { PayloadValidationError } from "../../context/errors.js";
import type { EventSource } from "../../event-source.js";
import type { Middleware } from "../../triggers/http.js";
import { renderTriggerPage } from "./page.js";

function renderSuccessBanner() {
	return html`<div class="banner success">Event emitted</div>`;
}

function renderErrorBanner(
	eventType: string,
	issues: { path: string; message: string }[],
) {
	const issueList =
		issues.length > 0
			? issues.map(
					(i) =>
						html`<li><strong>${i.path || "(root)"}</strong>: ${i.message}</li>`,
				)
			: html`<li>Invalid payload for event <strong>${eventType}</strong></li>`;
	return html`<div class="banner error"><ul>${issueList}</ul></div>`;
}

function triggerMiddleware(
	schemaSource: { readonly jsonSchemas: Record<string, object> },
	source: EventSource,
): Middleware {
	const app = new Hono().basePath("/trigger");

	app.get("/", (c) => {
		const user = c.req.header("X-Auth-Request-User") ?? "";
		const email = c.req.header("X-Auth-Request-Email") ?? "";
		return c.html(renderTriggerPage(schemaSource.jsonSchemas, user, email));
	});

	app.post("/:eventType", async (c) => {
		const eventType = c.req.param("eventType");

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.html(
				renderErrorBanner(eventType, [
					{ path: "", message: "Invalid JSON body" },
				]),
			);
		}

		try {
			await source.create(eventType, body, "trigger-ui");
		} catch (error) {
			if (error instanceof PayloadValidationError) {
				return c.html(renderErrorBanner(error.eventType, error.issues));
			}
			throw error;
		}

		return c.html(renderSuccessBanner());
	});

	return {
		match: "/trigger/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export { triggerMiddleware };
