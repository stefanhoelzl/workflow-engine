import { Hono } from "hono";
import { extname } from "node:path";
import type { Middleware } from "../../triggers/http.js";

import alpineJs from "alpinejs/dist/cdn.min.js?raw";
import htmxJs from "htmx.org/dist/htmx.min.js?raw";
import jedisonJs from "jedison/browser?raw";

const vendorFiles: Record<string, string> = {
	"alpine.js": alpineJs,
	"htmx.js": htmxJs,
	"jedison.js": jedisonJs,
};

const projectFiles = import.meta.glob("./*", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css",
	".html": "text/html",
	".js": "application/javascript",
};

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

const files = new Map<string, { content: string; contentType: string }>();

for (const [key, content] of Object.entries(projectFiles)) {
	const name = key.replace("./", "");
	const ext = extname(name);
	const contentType = CONTENT_TYPES[ext];
	if (contentType) {
		files.set(name, { content, contentType });
	}
}

for (const [name, content] of Object.entries(vendorFiles)) {
	const ext = extname(name);
	const contentType = CONTENT_TYPES[ext];
	if (contentType) {
		files.set(name, { content, contentType });
	}
}

function staticMiddleware(): Middleware {
	const app = new Hono().basePath("/static");

	app.get("/:file", (c) => {
		const file = c.req.param("file");
		const entry = files.get(file);
		if (!entry) {
			return c.notFound();
		}
		return c.body(entry.content, {
			headers: {
				"content-type": entry.contentType,
				"cache-control": IMMUTABLE_CACHE,
			},
		});
	});

	return {
		match: "/static/*",
		handler: async (c) => app.fetch(c.req.raw),
	};
}

export { staticMiddleware };
