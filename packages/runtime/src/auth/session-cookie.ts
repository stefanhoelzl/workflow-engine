import { SEVEN_DAYS_MS, TEN_MINUTES_MS } from "./constants.js";
import { createSealedCookie } from "./sealed-cookie.js";
import type { UserContext } from "./user-context.js";

interface SessionPayload {
	readonly name: string;
	readonly mail: string;
	readonly orgs: readonly string[];
	readonly accessToken: string;
	readonly resolvedAt: number;
	readonly exp: number;
}

const sessionCookie = createSealedCookie<SessionPayload>(SEVEN_DAYS_MS);

const sealSession = sessionCookie.seal;
const unsealSession = sessionCookie.unseal;

function userFromPayload(payload: SessionPayload): UserContext {
	return { name: payload.name, mail: payload.mail, orgs: payload.orgs };
}

function isStale(payload: SessionPayload, now: number): boolean {
	return now >= payload.resolvedAt + TEN_MINUTES_MS;
}

function isExpired(payload: SessionPayload, now: number): boolean {
	return now >= payload.exp;
}

export type { SessionPayload };
export { isExpired, isStale, sealSession, unsealSession, userFromPayload };
