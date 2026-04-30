import { Hono } from "hono";
import { requireOwnerMember } from "../auth/owner-mw.js";
import type { ProviderRegistry } from "../auth/providers/index.js";
import type { EventStore } from "../event-store.js";
import type { Logger } from "../logger.js";
import type { SecretsKeyStore } from "../secrets/index.js";
import { createNotFoundHandler } from "../services/content-negotiation.js";
import type { Middleware } from "../triggers/http.js";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { apiAuthMiddleware } from "./auth.js";
import { createPublicKeyHandler } from "./public-key.js";
import { createUploadHandler } from "./upload.js";

// ---------------------------------------------------------------------------
// /api/* mount
// ---------------------------------------------------------------------------
//
// `/api/*` is the authenticated management plane. v1 exposes:
//   POST /api/workflows/:owner/:repo — upload a repo workflow bundle (see
//       upload.ts).
//   GET  /api/workflows/:owner/public-key — serve the current primary X25519
//       public key so the `wfe upload` CLI can seal secrets before POSTing.
//
// SECURITY (CLAUDE.md + /SECURITY.md §4): `/api/*` dispatches by
// X-Auth-Provider; each registered provider resolves identity from the raw
// request. Session cookies are never read on this surface.

interface ApiOptions {
	registry: WorkflowRegistry;
	authRegistry: ProviderRegistry;
	logger: Logger;
	keyStore: SecretsKeyStore;
	eventStore: EventStore;
}

function apiMiddleware(options: ApiOptions): Middleware {
	const app = new Hono().basePath("/api");

	app.use("/*", apiAuthMiddleware({ registry: options.authRegistry }));

	app.use("/workflows/:owner", requireOwnerMember());
	app.use("/workflows/:owner/:repo", requireOwnerMember());
	app.use("/workflows/:owner/*", requireOwnerMember());
	app.notFound(createNotFoundHandler());

	app.post(
		"/workflows/:owner/:repo",
		createUploadHandler({
			registry: options.registry,
			logger: options.logger,
			keyStore: options.keyStore,
			eventStore: options.eventStore,
		}),
	);

	app.get(
		"/workflows/:owner/public-key",
		createPublicKeyHandler({ keyStore: options.keyStore }),
	);

	return {
		match: "/api/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export type { ApiOptions };
export { apiMiddleware };
