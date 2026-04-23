import type { DispatchMeta } from "@workflow-engine/core";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { tenantSet, validateTenant } from "../../auth/tenant.js";
import { requireTenantMember } from "../../auth/tenant-mw.js";
import type {
	BaseTriggerDescriptor,
	HttpTriggerDescriptor,
} from "../../executor/types.js";
import type { Middleware } from "../../triggers/http.js";
import type { WorkflowRegistry } from "../../workflow-registry.js";
import { renderTriggerPage } from "./page.js";

// ---------------------------------------------------------------------------
// /trigger/* — operator UI for manually firing registered triggers
// ---------------------------------------------------------------------------
//
// Renders a GET page listing every registered trigger (any kind) scoped to
// the user's active tenant. HTTP triggers submit directly to their public
// webhook URL (`/webhooks/<tenant>/<workflow>/<trigger-name>`) — the HTTP
// source fills in headers/url/method from the real HTTP
// request. Non-HTTP kinds (future cron/mail) submit to the kind-agnostic
// POST `/trigger/<tenant>/<workflow>/<trigger-name>` endpoint served here;
// this endpoint validates the body against `descriptor.inputSchema` via the
// shared `validate()` and dispatches through the shared executor.
//
// SECURITY (§4): mounted under `/trigger/*`, which oauth2-proxy protects
// at Traefik via forward-auth. Cross-tenant form submissions (which hit
// the public webhooks ingress) are still unauthenticated per §3.

interface TriggerMiddlewareDeps {
	readonly registry: WorkflowRegistry;
	// Optional session middleware to mount before the trigger handlers.
	// In production this is the in-app auth `sessionMiddleware`; in tests
	// the field is omitted and tests inject `UserContext` directly.
	readonly sessionMw?: MiddlewareHandler;
}

const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_NOT_FOUND = 404;

function sortedTenants(c: Context, registry: WorkflowRegistry): string[] {
	const user = c.get("user");
	if (user) {
		return Array.from(tenantSet(user)).sort();
	}
	// Dev/unauthenticated fallback: show tenants present in the registry.
	// In production, oauth2-proxy ensures a user header is always set on
	// `/trigger/*`; reaching this branch means open-mode dev.
	const fromRegistry = new Set<string>();
	for (const tenant of registry.tenants()) {
		if (validateTenant(tenant)) {
			fromRegistry.add(tenant);
		}
	}
	return Array.from(fromRegistry).sort();
}

// biome-ignore lint/complexity/useMaxParams: wraps posted body into the kind-specific input shape; parts are already available at the call site
function wrapInputForDescriptor(
	descriptor: BaseTriggerDescriptor<string>,
	body: unknown,
	tenant: string,
	workflowName: string,
	triggerName: string,
): unknown {
	if (descriptor.kind === "http") {
		const http = descriptor as HttpTriggerDescriptor;
		// Server-side synthesis: build the full HttpTriggerPayload the HTTP
		// trigger backend would normally construct from a real webhook
		// request. Headers are intentionally empty (leaking dispatch-path
		// specifics into guest-visible headers would be wrong); url is the
		// canonical relative webhook path; method comes from the descriptor.
		return {
			body,
			headers: {},
			url: `/webhooks/${tenant}/${workflowName}/${triggerName}`,
			method: http.method,
		};
	}
	return body;
}

function buildDispatch(c: Context): DispatchMeta {
	const user = c.get("user");
	if (user && typeof user.name === "string" && typeof user.mail === "string") {
		return {
			source: "manual",
			user: { name: user.name, mail: user.mail },
		};
	}
	// Open-mode dev (`authOpen` set, no session user). Fires still go
	// through `/trigger/*` authenticated by the middleware, but there is
	// no real identity to attribute to. Attach a sentinel so the
	// dashboard chip has a non-empty tooltip on hover.
	if (c.get("authOpen")) {
		return {
			source: "manual",
			user: { name: "local", mail: "" },
		};
	}
	return { source: "manual" };
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires page-render GET and kind-agnostic POST dispatch; splitting fragments the handler flow
function triggerMiddleware(deps: TriggerMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/trigger");
	if (deps.sessionMw) {
		app.use("*", deps.sessionMw);
	}
	app.use("/:tenant/*", requireTenantMember());
	app.notFound((c) => c.json({ error: "Not Found" }, HTTP_NOT_FOUND));

	const render = (c: Context) => {
		const user = c.get("user");
		const tenants = sortedTenants(c, deps.registry);
		const activeTenant = resolveActiveTenant(c, tenants);
		const scopedEntries = activeTenant ? deps.registry.list(activeTenant) : [];
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

	// POST /trigger/<tenant>/<workflow>/<triggerName> — kind-agnostic manual
	// fire. Validates JSON body against descriptor.inputSchema and dispatches
	// via the shared executor. Response returns `{ ok, output }` on success
	// or `{ error: "internal_error" }` on failure.
	app.post("/:tenant/:workflow/:trigger", async (c) => {
		const tenant = c.req.param("tenant");
		const workflowName = c.req.param("workflow");
		const triggerName = c.req.param("trigger");

		const entry = deps.registry.getEntry(tenant, workflowName, triggerName);
		if (!entry) {
			return c.notFound();
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(
				{
					error: "payload_validation_failed",
					issues: [{ path: ["body"], message: "Invalid JSON body" }],
				},
				HTTP_UNPROCESSABLE_ENTITY,
			);
		}

		const input = wrapInputForDescriptor(
			entry.descriptor,
			body,
			tenant,
			workflowName,
			triggerName,
		);
		const dispatch = buildDispatch(c);
		const result = await entry.fire(input, dispatch);
		if (!result.ok) {
			if (result.error.issues) {
				return c.json(
					{
						error: "payload_validation_failed",
						issues: result.error.issues,
					},
					HTTP_UNPROCESSABLE_ENTITY,
				);
			}
			return c.json(
				{ error: "internal_error", details: result.error },
				HTTP_INTERNAL_ERROR,
			);
		}
		return c.json({ ok: true, output: result.output });
	});

	return {
		match: "/trigger/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { TriggerMiddlewareDeps };
export { triggerMiddleware };
