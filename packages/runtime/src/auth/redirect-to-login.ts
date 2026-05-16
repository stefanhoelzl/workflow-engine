import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
	FLASH_COOKIE,
	LOGIN_PATH,
	SESSION_COOKIE,
	SIXTY_SECONDS,
} from "./constants.js";
import { clearOpts, writeOpts } from "./cookie-opts.js";
import { type FlashPayload, sealFlash } from "./flash-cookie.js";

async function redirectToLoginWithFlash(
	c: Context,
	flash: FlashPayload,
	secureCookies: boolean,
): Promise<Response> {
	const sealed = await sealFlash(flash);
	setCookie(
		c,
		FLASH_COOKIE,
		sealed,
		writeOpts("/", secureCookies, SIXTY_SECONDS),
	);
	deleteCookie(c, SESSION_COOKIE, clearOpts("/", secureCookies));
	return c.redirect(LOGIN_PATH);
}

export { redirectToLoginWithFlash };
