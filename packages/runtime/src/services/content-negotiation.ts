import { constants } from "node:http2";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SESSION_COOKIE } from "../auth/constants.js";
import {
	isExpired,
	unsealSession,
	userFromPayload,
} from "../auth/session-cookie.js";
import type { Logger } from "../logger.js";
import { ErrorPage, NotFoundPage } from "../ui/error-pages.js";

const HTTP_NOT_FOUND = constants.HTTP_STATUS_NOT_FOUND as ContentfulStatusCode;
const HTTP_INTERNAL_SERVER_ERROR =
	constants.HTTP_STATUS_INTERNAL_SERVER_ERROR as ContentfulStatusCode;

// Component references — PascalCase mandated by JSX render sites
// (`<pages.NotFoundPage/>` requires uppercase). Biome's useNamingConvention
// can't tell these are components.
//
// Components accept optional { user, email } so the universal topbar can
// render user identity when the request resolved a session. Per
// `ui-foundation` "Universal topbar" + `ui-errors`: best-effort, no
// defensive fallback — c.get("user") is read directly; if absent, the
// topbar shows brand only.
interface PageProps {
	readonly user?: string;
	readonly email?: string;
}

interface Pages {
	// biome-ignore lint/style/useNamingConvention: JSX component reference
	readonly NotFoundPage: (props?: PageProps) => unknown;
	// biome-ignore lint/style/useNamingConvention: JSX component reference
	readonly ErrorPage: (props?: PageProps) => unknown;
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

// `UserContext` lives in auth/user-context but importing it here would create
// a dependency cycle (auth → services → auth). The shape we read is
// intentionally minimal: { login, mail }. Anything richer stays unread on
// this path.
interface UserShape {
	readonly login?: string;
	readonly mail?: string;
}

// Best-effort session read for paths that aren't gated by sessionMw (the
// global notFound and onError handlers). If c.get("user") was set by an
// auth-aware middleware higher up, we trust it; otherwise we try to unseal
// the session cookie ourselves and surface user identity in the topbar
// when the cookie is valid. Failures degrade silently to anonymous
// rendering — no defensive try-catch beyond what unsealSession already
// throws on tampered/expired material.
async function readUserBestEffort(c: Context): Promise<UserShape | undefined> {
	const fromContext = c.get("user") as UserShape | undefined;
	if (fromContext) {
		return fromContext;
	}
	const raw = getCookie(c, SESSION_COOKIE);
	if (!raw) {
		return;
	}
	try {
		const payload = await unsealSession(raw);
		if (isExpired(payload, Date.now())) {
			return;
		}
		return userFromPayload(payload);
	} catch {
		return;
	}
}

async function userPropsFromContext(c: Context): Promise<PageProps> {
	const user = await readUserBestEffort(c);
	if (!user) {
		return {};
	}
	const props: { user?: string; email?: string } = {};
	if (user.login) {
		props.user = user.login;
	}
	if (user.mail) {
		props.email = user.mail;
	}
	return props;
}

function createNotFoundHandler(pages: Pages = defaultPages): NotFoundHandler {
	return async (c) => {
		if (!acceptsHtml(c)) {
			return c.json({ error: "Not Found" }, HTTP_NOT_FOUND);
		}
		const props = await userPropsFromContext(c);
		return c.html(String(pages.NotFoundPage(props)), HTTP_NOT_FOUND);
	};
}

function createErrorHandler(
	opts: { pages?: Pages; logger?: Logger } = {},
): ErrorHandler {
	const pages = opts.pages ?? defaultPages;
	const logger = opts.logger;
	return async (err, c) => {
		logger?.error("http.unhandled-error", {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			path: c.req.path,
			method: c.req.method,
		});
		if (!acceptsHtml(c)) {
			return c.json(
				{ error: "Internal Server Error" },
				HTTP_INTERNAL_SERVER_ERROR,
			);
		}
		const props = await userPropsFromContext(c);
		return c.html(String(pages.ErrorPage(props)), HTTP_INTERNAL_SERVER_ERROR);
	};
}

export type { Pages };
export { acceptsHtml, createErrorHandler, createNotFoundHandler };
