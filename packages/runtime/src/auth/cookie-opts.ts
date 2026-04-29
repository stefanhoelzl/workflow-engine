import type { CookieOptions } from "hono/utils/cookie";

// Single source of truth for session/flash/state cookie attributes. All
// `setCookie`/`deleteCookie` call sites in `auth/` MUST go through these so
// write/clear cannot diverge. Diverging shapes break delete under CHIPS:
// browsers treat partitioned and unpartitioned cookies as separate jar
// entries, so an unpartitioned `Set-Cookie: name=; Max-Age=0` cannot clear
// a cookie originally written with `Partitioned`.
//
// In local dev (`secure=false`), cookies must work inside the VS Code
// Simple Browser webview, which embeds localhost in an iframe whose
// top-level origin is `vscode-webview://…`. From Chrome's view that's a
// cross-site context, so a `SameSite=Lax` cookie is dropped. Localhost is
// a "potentially trustworthy" origin per the W3C Secure Contexts spec, so
// Chrome accepts `Secure` cookies on `http://localhost`. The `Partitioned`
// attribute opts into CHIPS so the cookie is keyed to the embedding
// vscode-webview origin.
function clearOpts(path: string, secure: boolean): CookieOptions {
	if (secure) {
		return { path, secure: true, httpOnly: true, sameSite: "Lax" };
	}
	return {
		path,
		secure: true,
		httpOnly: true,
		sameSite: "None",
		partitioned: true,
	};
}

function writeOpts(
	path: string,
	secure: boolean,
	maxAge: number,
): CookieOptions {
	return { ...clearOpts(path, secure), maxAge };
}

export { clearOpts, writeOpts };
