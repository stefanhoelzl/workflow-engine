import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import {
	HttpTriggerRegistry,
	httpTriggerMiddleware,
} from "./triggers/http.js";

const registry = new HttpTriggerRegistry();

// Temporary hardcoded trigger — replaced when SDK/manifest lands
registry.register({
	path: "order",
	method: "POST",
	response: { status: 202, body: { accepted: true } },
});

const app = createServer(
	httpTriggerMiddleware(registry, (definition, body) => {
		// biome-ignore lint/suspicious/noConsole: entry point logging
		console.log(`Trigger fired: ${definition.method} /webhooks/${definition.path}`, body);
	}),
);

const port = 3000;
// biome-ignore lint/suspicious/noConsole: entry point logging
console.log(`Runtime listening on port ${port}`);
serve({ fetch: app.fetch, port });
