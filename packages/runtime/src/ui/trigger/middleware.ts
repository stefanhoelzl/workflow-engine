import type { Context } from "hono";
import { Hono } from "hono";
import { headerUserMiddleware } from "../../auth/header-user.js";
import { tenantSet, validateTenant } from "../../auth/tenant.js";
import type { Executor } from "../../executor/index.js";
import type { TriggerDescriptor } from "../../executor/types.js";
import type { Middleware } from "../../triggers/http.js";
import { validate } from "../../triggers/validator.js";
import type {
	WorkflowEntry,
	WorkflowRegistry,
} from "../../workflow-registry.js";
import { renderTriggerPage } from "./page.js";

// ---------------------------------------------------------------------------
// /trigger/* — operator UI for manually firing registered triggers
// ---------------------------------------------------------------------------
//
// Renders a GET page listing every registered trigger (any kind) scoped to
// the user's active tenant. HTTP triggers submit directly to their public
// webhook URL (`/webhooks/<tenant>/<workflow>/<trigger-path>`) — the HTTP
// source fills in headers/url/method/params/query from the real HTTP
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
	readonly executor: Executor;
}

const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;

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

interface ResolvedTrigger {
	readonly entry: WorkflowEntry;
	readonly descriptor: TriggerDescriptor;
}

function resolveTrigger(
	registry: WorkflowRegistry,
	tenant: string,
	workflowName: string,
	triggerName: string,
): ResolvedTrigger | undefined {
	for (const entry of registry.list(tenant)) {
		if (entry.workflow.name !== workflowName) {
			continue;
		}
		const descriptor = entry.triggers.find((t) => t.name === triggerName);
		if (!descriptor) {
			return;
		}
		return { entry, descriptor };
	}
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure wires page-render GET and kind-agnostic POST dispatch; splitting fragments the handler flow
function triggerMiddleware(deps: TriggerMiddlewareDeps): Middleware {
	const app = new Hono().basePath("/trigger");
	app.use("*", headerUserMiddleware());

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
		const user = c.get("user");
		const tenant = c.req.param("tenant");
		const workflowName = c.req.param("workflow");
		const triggerName = c.req.param("trigger");

		if (!validateTenant(tenant)) {
			return c.notFound();
		}
		if (user && !tenantSet(user).has(tenant)) {
			return c.notFound();
		}

		const match = resolveTrigger(
			deps.registry,
			tenant,
			workflowName,
			triggerName,
		);
		if (!match) {
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

		const validated = validate(match.descriptor, body);
		if (!validated.ok) {
			return c.json(
				{ error: "payload_validation_failed", issues: validated.issues },
				HTTP_UNPROCESSABLE_ENTITY,
			);
		}

		const result = await deps.executor.invoke(
			match.entry.tenant,
			match.entry.workflow,
			match.descriptor,
			validated.input,
			match.entry.bundleSource,
		);
		if (!result.ok) {
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
