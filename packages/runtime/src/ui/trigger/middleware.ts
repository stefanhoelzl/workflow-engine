import type { Context } from "hono";
import { Hono } from "hono";
import { tenantSet, validateTenant } from "../../auth/tenant.js";
import { userMiddleware } from "../../auth/user.js";
import type { HttpTriggerRegistry, Middleware } from "../../triggers/http.js";
import { renderTriggerPage } from "./page.js";

// ---------------------------------------------------------------------------
// /trigger/* — operator UI for manually firing registered HTTP triggers
// ---------------------------------------------------------------------------
//
// Renders a GET-only UI listing every registered HTTP trigger scoped to the
// user's active tenant as a collapsible form (body JSON Schema -> jedison
// form). The "Submit" button POSTs to the tenant-scoped webhook URL
// (`/webhooks/<tenant>/<workflow>/<trigger-path>`) — the same public path an
// external caller would use.
//
// SECURITY (§4): mounted under `/trigger/*`, which oauth2-proxy protects
// at Traefik via forward-auth — unauthenticated users are redirected to
// sign-in. The runtime itself does NOT enforce auth on `/trigger/*`; the
// infrastructure layer does. The tenant selector limits what the UI offers;
// cross-tenant form submissions (which hit the public webhooks ingress) are
// still unauthenticated per §3.

interface TriggerMiddlewareDeps {
	readonly triggerRegistry: HttpTriggerRegistry;
}

function sortedTenants(c: Context, registry: HttpTriggerRegistry): string[] {
	const user = c.get("user");
	if (user) {
		return Array.from(tenantSet(user)).sort();
	}
	// Dev/unauthenticated fallback: show tenants present in the trigger
	// registry. In production, oauth2-proxy ensures a user header is always
	// set on `/trigger/*`; reaching this branch means open-mode dev.
	const fromRegistry = new Set<string>();
	for (const entry of registry.list()) {
		if (validateTenant(entry.workflow.tenant)) {
			fromRegistry.add(entry.workflow.tenant);
		}
	}
	return Array.from(fromRegistry).sort();
}

function resolveActiveTenant(
	c: Context,
	tenants: string[],
): string | undefined {
	if (tenants.length === 0) {
		return;
	}
	const requested = c.req.query("tenant");
	if (requested && tenants.includes(requested)) {
		return requested;
	}
	return tenants[0];
}

function triggerMiddleware(deps: TriggerMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/trigger");
	app.use("*", userMiddleware());

	const render = (c: Context) => {
		const user = c.get("user");
		const tenants = sortedTenants(c, deps.triggerRegistry);
		const activeTenant = resolveActiveTenant(c, tenants);
		const allEntries = deps.triggerRegistry.list();
		const scopedEntries = activeTenant
			? allEntries.filter((e) => e.workflow.tenant === activeTenant)
			: [];
		return c.html(
			renderTriggerPage({
				entries: scopedEntries,
				user: user?.name ?? "",
				email: user?.mail ?? "",
				tenants,
				activeTenant,
			}),
		);
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
