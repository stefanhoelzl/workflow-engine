import { constants } from "node:http2";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../logger.js";
import notFoundHtml from "../ui/static/404.html?raw";
import errorHtml from "../ui/static/error.html?raw";

const HTTP_NOT_FOUND = constants.HTTP_STATUS_NOT_FOUND as ContentfulStatusCode;
const HTTP_INTERNAL_SERVER_ERROR =
	constants.HTTP_STATUS_INTERNAL_SERVER_ERROR as ContentfulStatusCode;

interface Pages {
	notFound: string;
	error: string;
}

const defaultPages: Pages = { notFound: notFoundHtml, error: errorHtml };

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
			? c.html(pages.notFound, HTTP_NOT_FOUND)
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
			? c.html(pages.error, HTTP_INTERNAL_SERVER_ERROR)
			: c.json({ error: "Internal Server Error" }, HTTP_INTERNAL_SERVER_ERROR);
	};
}

export type { Pages };
export { acceptsHtml, createErrorHandler, createNotFoundHandler };
