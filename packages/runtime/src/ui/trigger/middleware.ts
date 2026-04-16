import type { Context } from "hono";
import { Hono } from "hono";
import type { HttpTriggerRegistry, Middleware } from "../../triggers/http.js";
import { renderTriggerPage } from "./page.js";

// ---------------------------------------------------------------------------
// /trigger/* — operator UI for manually firing registered HTTP triggers
// ---------------------------------------------------------------------------
//
// Renders a GET-only UI listing every registered HTTP trigger as a
// collapsible form (body JSON Schema -> jedison form). The "Submit" button
// POSTs (or whatever method the trigger declares) directly to the
// `/webhooks/<path>` ingress — the same public path an external caller
// would use. This deliberately keeps the UI a thin wrapper around the
// webhook plane: no trigger-UI-specific backend path, no parallel
// validation, one code path for real invocations and UI-driven ones.
//
// SECURITY (§4): mounted under `/trigger/*`, which oauth2-proxy protects
// at Traefik via forward-auth — unauthenticated users are redirected to
// sign-in. The runtime itself does NOT enforce auth on `/trigger/*`; the
// infrastructure layer does. CLAUDE.md documents this invariant. Adding a
// new UI route under a different prefix requires a matching oauth2-proxy
// forward-auth rule.

interface TriggerMiddlewareDeps {
	readonly triggerRegistry: HttpTriggerRegistry;
}

function triggerMiddleware(deps: TriggerMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/trigger");

	const render = (c: Context) => {
		const user = c.req.header("X-Auth-Request-User") ?? "";
		const email = c.req.header("X-Auth-Request-Email") ?? "";
		return c.html(renderTriggerPage(deps.triggerRegistry.list(), user, email));
	};
	app.get("/", render);
	app.get("", render);

	return {
		match: "/trigger/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { TriggerMiddlewareDeps };
export { triggerMiddleware };
