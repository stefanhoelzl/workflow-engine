import { describe, expect, it } from "vitest";
import { SEVEN_DAYS_MS, TEN_MINUTES_MS } from "./constants.js";
import {
	isExpired,
	isStale,
	type SessionPayload,
	sealSession,
	unsealSession,
	userFromPayload,
} from "./session-cookie.js";

function makePayload(over: Partial<SessionPayload> = {}): SessionPayload {
	const now = 1_700_000_000_000;
	return {
		provider: "github",
		name: "alice",
		mail: "alice@example.test",
		orgs: ["acme"],
		accessToken: "gho_xxx",
		resolvedAt: now,
		exp: now + SEVEN_DAYS_MS,
		...over,
	};
}

describe("session-cookie", () => {
	it("seals and unseals a payload", async () => {
		const payload = makePayload();
		const sealed = await sealSession(payload);
		const unsealed = await unsealSession(sealed);
		expect(unsealed.name).toBe(payload.name);
		expect(unsealed.mail).toBe(payload.mail);
		expect(unsealed.orgs).toEqual(payload.orgs);
		expect(unsealed.accessToken).toBe(payload.accessToken);
	});

	it("rejects a tampered cookie", async () => {
		const sealed = await sealSession(makePayload());
		const tampered = `${sealed.slice(0, -2)}XX`;
		await expect(unsealSession(tampered)).rejects.toThrow();
	});

	it("userFromPayload drops accessToken and timestamps", () => {
		const payload = makePayload();
		const user = userFromPayload(payload);
		expect(user).toEqual({
			name: "alice",
			mail: "alice@example.test",
			orgs: ["acme"],
		});
		expect((user as any).accessToken).toBeUndefined();
	});

	it("isStale detects resolvedAt older than soft TTL", () => {
		const now = 2_000_000_000_000;
		const fresh = makePayload({ resolvedAt: now - 1000 });
		expect(isStale(fresh, now)).toBe(false);
		const stale = makePayload({ resolvedAt: now - TEN_MINUTES_MS - 1 });
		expect(isStale(stale, now)).toBe(true);
	});

	it("isExpired detects hard TTL exceeded", () => {
		const now = 2_000_000_000_000;
		const live = makePayload({ exp: now + 1000 });
		expect(isExpired(live, now)).toBe(false);
		const dead = makePayload({ exp: now - 1 });
		expect(isExpired(dead, now)).toBe(true);
	});
});
