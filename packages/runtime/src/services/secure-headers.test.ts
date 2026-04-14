import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	buildCsp,
	buildPermissionsPolicy,
	secureHeadersMiddleware,
} from "./secure-headers.js";
import { createApp } from "./server.js";

const REMOTE_ORIGIN_SCHEME = /\bhttps?:/;
const EXPECTED_HEADERS: ReadonlyArray<readonly [string, string]> = [
	["X-Content-Type-Options", "nosniff"],
	["X-Frame-Options", "DENY"],
	["Referrer-Policy", "strict-origin-when-cross-origin"],
	["Cross-Origin-Opener-Policy", "same-origin"],
	["Cross-Origin-Resource-Policy", "same-origin"],
];

async function fetchHeaders(
	localDeployment?: string,
): Promise<Record<string, string | null>> {
	const mw = secureHeadersMiddleware(
		localDeployment === undefined ? {} : { localDeployment },
	);
	const app = new Hono();
	app.use(mw.match, mw.handler);
	app.get("/probe", (c) => c.text("ok"));
	const res = await app.request("/probe");
	return {
		csp: res.headers.get("Content-Security-Policy"),
		xcto: res.headers.get("X-Content-Type-Options"),
		xfo: res.headers.get("X-Frame-Options"),
		referrer: res.headers.get("Referrer-Policy"),
		coop: res.headers.get("Cross-Origin-Opener-Policy"),
		corp: res.headers.get("Cross-Origin-Resource-Policy"),
		permissions: res.headers.get("Permissions-Policy"),
		hsts: res.headers.get("Strict-Transport-Security"),
	};
}

describe("buildCsp", () => {
	it("starts with default-src 'none'", () => {
		expect(buildCsp().startsWith("default-src 'none'")).toBe(true);
	});

	it("includes every required directive exactly once", () => {
		const csp = buildCsp();
		for (const directive of [
			"default-src 'none'",
			"script-src 'self'",
			"style-src 'self'",
			"img-src 'self' data:",
			"connect-src 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
			"base-uri 'none'",
		]) {
			expect(csp).toContain(directive);
		}
	});

	it("contains no unsafe tokens", () => {
		const csp = buildCsp();
		expect(csp).not.toContain("'unsafe-inline'");
		expect(csp).not.toContain("'unsafe-eval'");
		expect(csp).not.toContain("'unsafe-hashes'");
		expect(csp).not.toContain("'strict-dynamic'");
	});

	it("contains no remote origins", () => {
		const csp = buildCsp();
		expect(csp).not.toMatch(REMOTE_ORIGIN_SCHEME);
		expect(csp).not.toContain("*");
	});
});

describe("buildPermissionsPolicy", () => {
	it("disables every sensor and capability feature", () => {
		const policy = buildPermissionsPolicy();
		for (const feature of [
			"camera",
			"microphone",
			"geolocation",
			"usb",
			"payment",
			"clipboard-read",
		]) {
			expect(policy).toContain(`${feature}=()`);
		}
	});

	it("allows clipboard-write from self only", () => {
		expect(buildPermissionsPolicy()).toContain("clipboard-write=(self)");
	});
});

describe("secureHeadersMiddleware", () => {
	it("sets every baseline header in production mode", async () => {
		const headers = await fetchHeaders();
		expect(headers.csp).not.toBeNull();
		expect(headers.xcto).toBe("nosniff");
		expect(headers.xfo).toBe("DENY");
		expect(headers.referrer).toBe("strict-origin-when-cross-origin");
		expect(headers.coop).toBe("same-origin");
		expect(headers.corp).toBe("same-origin");
		expect(headers.permissions).not.toBeNull();
		expect(headers.hsts).toBe("max-age=31536000; includeSubDomains");
	});

	it("omits HSTS when LOCAL_DEPLOYMENT=1", async () => {
		const headers = await fetchHeaders("1");
		expect(headers.hsts).toBeNull();
		expect(headers.csp).not.toBeNull();
		expect(headers.xfo).toBe("DENY");
	});

	it("emits HSTS when LOCAL_DEPLOYMENT has any non-'1' value", async () => {
		const headers = await fetchHeaders("true");
		expect(headers.hsts).toBe("max-age=31536000; includeSubDomains");
	});

	it("emits HSTS when LOCAL_DEPLOYMENT is unset", async () => {
		const headers = await fetchHeaders(undefined);
		expect(headers.hsts).toBe("max-age=31536000; includeSubDomains");
	});

	it("emits CSP containing default-src 'none' on the response", async () => {
		const headers = await fetchHeaders();
		expect(headers.csp).toContain("default-src 'none'");
	});
});

describe("secureHeadersMiddleware: per-route integration", () => {
	const ROUTE_FAMILIES = [
		{ name: "livez", path: "/livez" },
		{ name: "webhook", path: "/webhooks/order" },
		{ name: "api", path: "/api/events" },
		{ name: "dashboard", path: "/dashboard" },
		{ name: "trigger", path: "/trigger" },
		{ name: "static", path: "/static/alpine.js" },
	] as const;

	function stubMiddleware(match: string, body: string) {
		return {
			match,
			handler: async (c: Parameters<Middleware["handler"]>[0]) => c.text(body),
		};
	}

	type Middleware = ReturnType<typeof secureHeadersMiddleware>;

	function missingBaselineHeaders(res: Response): string[] {
		const missing: string[] = [];
		const csp = res.headers.get("Content-Security-Policy");
		if (csp === null || !csp.includes("default-src 'none'")) {
			missing.push("Content-Security-Policy");
		}
		for (const [name, expected] of EXPECTED_HEADERS) {
			if (res.headers.get(name) !== expected) {
				missing.push(name);
			}
		}
		const perms = res.headers.get("Permissions-Policy");
		if (perms === null || !perms.includes("clipboard-write=(self)")) {
			missing.push("Permissions-Policy");
		}
		return missing;
	}

	function buildTestApp(localDeployment?: string) {
		return createApp(
			secureHeadersMiddleware(
				localDeployment === undefined ? {} : { localDeployment },
			),
			stubMiddleware("/livez", "ok"),
			stubMiddleware("/webhooks/*", "{}"),
			stubMiddleware("/api/*", "{}"),
			stubMiddleware("/dashboard/*", "<html></html>"),
			stubMiddleware("/trigger/*", "<html></html>"),
			stubMiddleware("/static/*", "/* js */"),
		);
	}

	for (const family of ROUTE_FAMILIES) {
		it(`applies every header to ${family.name} (${family.path})`, async () => {
			const res = await buildTestApp().request(family.path);
			expect(missingBaselineHeaders(res)).toEqual([]);
			expect(res.headers.get("Strict-Transport-Security")).toBe(
				"max-age=31536000; includeSubDomains",
			);
		});
	}

	it("omits HSTS on every route family when LOCAL_DEPLOYMENT=1", async () => {
		const app = buildTestApp("1");
		const results = await Promise.all(
			ROUTE_FAMILIES.map(async (family) => {
				const res = await app.request(family.path);
				return {
					name: family.name,
					missing: missingBaselineHeaders(res),
					hsts: res.headers.get("Strict-Transport-Security"),
				};
			}),
		);
		for (const result of results) {
			expect(result.missing).toEqual([]);
			expect(result.hsts).toBeNull();
		}
	});
});
