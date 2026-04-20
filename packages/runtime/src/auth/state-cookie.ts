import { FIVE_MINUTES_MS } from "./constants.js";
import { createSealedCookie } from "./sealed-cookie.js";

interface StatePayload {
	readonly state: string;
	readonly returnTo: string;
}

const stateCookie = createSealedCookie<StatePayload>(FIVE_MINUTES_MS);

const sealState = stateCookie.seal;
const unsealState = stateCookie.unseal;

function isSafeReturnTo(value: string): boolean {
	if (value === "" || !value.startsWith("/") || value.startsWith("//")) {
		return false;
	}
	if (value.includes("\\")) {
		return false;
	}
	const stop = Math.min(
		value.indexOf("?") === -1 ? value.length : value.indexOf("?"),
		value.indexOf("#") === -1 ? value.length : value.indexOf("#"),
	);
	return !value.slice(0, stop).includes(":");
}

function sanitizeReturnTo(value: string | undefined): string {
	if (value === undefined) {
		return "/";
	}
	return isSafeReturnTo(value) ? value : "/";
}

export type { StatePayload };
export { isSafeReturnTo, sanitizeReturnTo, sealState, unsealState };
