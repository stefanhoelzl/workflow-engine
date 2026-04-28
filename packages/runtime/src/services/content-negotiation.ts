import { constants } from "node:http2";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../logger.js";
import { ErrorPage, NotFoundPage } from "../ui/error-pages.js";

const HTTP_NOT_FOUND = constants.HTTP_STATUS_NOT_FOUND as ContentfulStatusCode;
const HTTP_INTERNAL_SERVER_ERROR =
	constants.HTTP_STATUS_INTERNAL_SERVER_ERROR as ContentfulStatusCode;

// Component references — PascalCase mandated by JSX render sites
// (`<pages.NotFoundPage/>` requires uppercase). Biome's useNamingConvention
// can't tell these are components.
interface Pages {
	// biome-ignore lint/style/useNamingConvention: JSX component reference
	readonly NotFoundPage: () => unknown;
	// biome-ignore lint/style/useNamingConvention: JSX component reference
	readonly ErrorPage: () => unknown;
}

// biome-ignore lint/style/useNamingConvention: JSX component references
const defaultPages: Pages = { NotFoundPage, ErrorPage };

function acceptsHtml(c: Context): boolean {
	const header = c.req.header("Accept");
	if (!header) {
		return false;
	}
	for (const segment of header.split(",")) {
		const mediaType = segment.split(";", 1)[0]?.trim().toLowerCase();
		if (mediaType === "text/html") {
			return true;
		}
	}
	return false;
}

function createNotFoundHandler(pages: Pages = defaultPages): NotFoundHandler {
	return (c) =>
		acceptsHtml(c)
			? c.html(String(pages.NotFoundPage()), HTTP_NOT_FOUND)
			: c.json({ error: "Not Found" }, HTTP_NOT_FOUND);
}

function createErrorHandler(
	opts: { pages?: Pages; logger?: Logger } = {},
): ErrorHandler {
	const pages = opts.pages ?? defaultPages;
	const logger = opts.logger;
	return (err, c) => {
		logger?.error("http.unhandled-error", {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			path: c.req.path,
			method: c.req.method,
		});
		return acceptsHtml(c)
			? c.html(String(pages.ErrorPage()), HTTP_INTERNAL_SERVER_ERROR)
			: c.json({ error: "Internal Server Error" }, HTTP_INTERNAL_SERVER_ERROR);
	};
}

export type { Pages };
export { acceptsHtml, createErrorHandler, createNotFoundHandler };
