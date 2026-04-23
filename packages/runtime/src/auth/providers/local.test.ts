import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../constants.js";
import { type SessionPayload, unsealSession } from "../session-cookie.js";
import { localProviderFactory } from "./local.js";
import type { ProviderRouteDeps } from "./types.js";

const NOW = 1_700_000_000_000;

const DEPS: ProviderRouteDeps = {
	secureCookies: false,
	nowFn: () => NOW,
};

function mountProvider(
	entries: readonly string[],
	deps: ProviderRouteDeps = DEPS,
): Hono {
	const provider = localProviderFactory.create(entries, deps);
	const sub = new Hono();
	provider.mountAuthRoutes(sub);
	return sub;
}

function getSetCookies(res: Response): string[] {
	return res.headers.getSetCookie();
}

function findCookie(cookies: string[], name: string): string | undefined {
	return cookies.find((c) => c.startsWith(`${name}=`));
}

function cookieValue(cookieHeader: string): string {
	return cookieHeader.split(";")[0]?.split("=").slice(1).join("=") ?? "";
}

describe("create", () => {
	it('accepts ["dev"] (single segment, no orgs)', () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		expect(provider.id).toBe("local");
	});

	it('accepts ["alice:acme|foo"] (orgs)', () => {
		const provider = localProviderFactory.create(["alice:acme|foo"], DEPS);
		expect(provider.id).toBe("local");
	});

	it('accepts ["alice:single"] (single org)', () => {
		const provider = localProviderFactory.create(["alice:single"], DEPS);
		expect(provider.id).toBe("local");
	});

	it("throws on [\"alice:acme,foo\"] — orgs use '|' separator", () => {
		expect(() => localProviderFactory.create(["alice:acme,foo"], DEPS)).toThrow(
			/orgs use '\|' separator/,
		);
	});

	it('throws on ["alice:has space"] — invalid identifier', () => {
		expect(() =>
			localProviderFactory.create(["alice:has space"], DEPS),
		).toThrow(/invalid local org "has space"/);
	});

	it('throws on ["alice:acme:extra"] — too many segments', () => {
		expect(() =>
			localProviderFactory.create(["alice:acme:extra"], DEPS),
		).toThrow(/malformed local entry/);
	});

	it('throws on ["bad name"] — invalid name', () => {
		expect(() => localProviderFactory.create(["bad name"], DEPS)).toThrow(
			/invalid local user name "bad name"/,
		);
	});
});

describe("renderLoginSection", () => {
	it('markup contains <form method="POST" action="/auth/local/signin">', async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const section = await provider.renderLoginSection("/");
		const markup = String(section);
		expect(markup).toContain('<form method="POST" action="/auth/local/signin"');
	});

	it("renders one <option> per entry name", async () => {
		const provider = localProviderFactory.create(
			["dev", "alice:acme", "bob"],
			DEPS,
		);
		const markup = String(await provider.renderLoginSection("/"));
		expect(markup).toContain('<option value="dev">dev</option>');
		expect(markup).toContain('<option value="alice">alice</option>');
		expect(markup).toContain('<option value="bob">bob</option>');
	});

	it("contains the hidden returnTo input carrying the passed-in value", async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const markup = String(await provider.renderLoginSection("/dashboard"));
		expect(markup).toContain(
			'<input type="hidden" name="returnTo" value="/dashboard">',
		);
	});
});

describe("mountAuthRoutes", () => {
	it("POST /signin with known user seals a session and redirects to returnTo", async () => {
		const sub = mountProvider(["dev"]);
		const res = await sub.request("/signin", {
			method: "POST",
			body: new URLSearchParams({ user: "dev", returnTo: "/dashboard" }),
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dashboard");
		const session = findCookie(getSetCookies(res), SESSION_COOKIE);
		expect(session).toBeDefined();
		const payload = await unsealSession(cookieValue(session ?? ""));
		expect(payload.provider).toBe("local");
		expect(payload.name).toBe("dev");
		expect(payload.mail).toBe("dev@dev.local");
		expect(payload.orgs).toEqual([]);
		expect(payload.accessToken).toBe("");
	});

	it("POST /signin with unknown user returns 400 and does not set a session cookie", async () => {
		const sub = mountProvider(["dev"]);
		const res = await sub.request("/signin", {
			method: "POST",
			body: new URLSearchParams({ user: "mallory", returnTo: "/dashboard" }),
		});
		expect(res.status).toBe(400);
		expect(findCookie(getSetCookies(res), SESSION_COOKIE)).toBeUndefined();
	});

	it("POST /signin sanitises unsafe returnTo to /", async () => {
		const sub = mountProvider(["alice:acme"]);
		const res = await sub.request("/signin", {
			method: "POST",
			body: new URLSearchParams({ user: "alice", returnTo: "//evil.example" }),
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
	});
});

describe("resolveApiIdentity", () => {
	it("returns user for Authorization: User <name> matching an entry (no orgs)", async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "User dev" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toEqual({ name: "dev", mail: "dev@dev.local", orgs: [] });
	});

	it("returns user with orgs when entry declares orgs", async () => {
		const provider = localProviderFactory.create(["alice:acme|foo"], DEPS);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "User alice" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toEqual({
			name: "alice",
			mail: "alice@dev.local",
			orgs: ["acme", "foo"],
		});
	});

	it("returns undefined for a name not in the allowlist", async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "User mallory" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
	});

	it("returns undefined for Bearer scheme (wrong scheme for local)", async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "Bearer xyz" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
	});

	it("returns undefined when Authorization header is missing", async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const req = new Request("https://example.test/api/x");
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
	});

	it('returns undefined for empty value after "User " prefix', async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "User " },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
	});
});

describe("refreshSession", () => {
	function mkPayload(): SessionPayload {
		return {
			provider: "local",
			name: "dev",
			mail: "dev@dev.local",
			orgs: ["acme"],
			accessToken: "",
			resolvedAt: NOW,
			exp: NOW + 1000,
		};
	}

	it("returns UserContext sourced from the payload", async () => {
		const provider = localProviderFactory.create(["dev"], DEPS);
		const user = await provider.refreshSession(mkPayload());
		expect(user).toEqual({
			name: "dev",
			mail: "dev@dev.local",
			orgs: ["acme"],
		});
	});

	it("never makes a network call", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("refreshSession must not call fetch");
		});
		const provider = localProviderFactory.create(["dev"], {
			...DEPS,
			fetchFn: fetchFn as unknown as typeof globalThis.fetch,
		});
		const user = await provider.refreshSession(mkPayload());
		expect(user).toBeDefined();
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
