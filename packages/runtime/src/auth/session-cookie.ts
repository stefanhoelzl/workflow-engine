import { SEVEN_DAYS_MS, TEN_MINUTES_MS } from "./constants.js";
import { createSealedCookie } from "./sealed-cookie.js";
import type { UserContext } from "./user-context.js";

type SessionProvider = "github" | "local";

interface SessionPayload {
	readonly provider: SessionProvider;
	readonly name: string;
	readonly mail: string;
	readonly orgs: readonly string[];
	readonly accessToken: string;
	readonly resolvedAt: number;
	readonly exp: number;
}

const sessionCookie = createSealedCookie<SessionPayload>(SEVEN_DAYS_MS);

const sealSession = sessionCookie.seal;
const rawUnseal = sessionCookie.unseal;

const VALID_PROVIDERS: ReadonlySet<SessionProvider> = new Set([
	"github",
	"local",
]);

async function unsealSession(raw: string): Promise<SessionPayload> {
	const payload = await rawUnseal(raw);
	if (
		payload === null ||
		typeof payload !== "object" ||
		!VALID_PROVIDERS.has(
			(payload as { provider?: unknown }).provider as SessionProvider,
		)
	) {
		throw new Error("session: missing or invalid provider field");
	}
	return payload;
}

function userFromPayload(payload: SessionPayload): UserContext {
	return { name: payload.name, mail: payload.mail, orgs: payload.orgs };
}

function isStale(payload: SessionPayload, now: number): boolean {
	return now >= payload.resolvedAt + TEN_MINUTES_MS;
}

function isExpired(payload: SessionPayload, now: number): boolean {
	return now >= payload.exp;
}

export type { SessionPayload, SessionProvider };
export { isExpired, isStale, sealSession, unsealSession, userFromPayload };
