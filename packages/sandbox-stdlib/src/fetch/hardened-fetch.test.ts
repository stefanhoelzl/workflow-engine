import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock() above imports, so the mock is installed before
// hardened-fetch.ts imports from node:dns/promises. Each test programs the
// `lookup` return via vi.mocked below.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(),
}));

import { lookup as mockLookup } from "node:dns/promises";
import { HostBlockedError } from "../net-guard/index.js";
import { hardenedFetch } from "./hardened-fetch.js";

// dns.promises.lookup has two overloads (single address vs array). vi.mocked
// picks the single-address overload by default; cast through unknown when
// returning arrays so the all:true callsite inside hardened-fetch.ts sees the
// expected shape at runtime. (Type-only erasure; no runtime impact.)
const lookup = vi.mocked(mockLookup) as unknown as {
	mockResolvedValueOnce: (
		value: Array<{ address: string; family: 4 | 6 }>,
	) => void;
	mockRejectedValueOnce: (err: unknown) => void;
	mockReset: () => void;
};

function mockResolve(addr: string, family: 4 | 6 = 4): void {
	lookup.mockResolvedValueOnce([{ address: addr, family }]);
}

function mockResolveMany(
	addrs: Array<{ address: string; family: 4 | 6 }>,
): void {
	lookup.mockResolvedValueOnce(addrs);
}

beforeEach(() => {
	lookup.mockReset();
});

// `isBlockedAddress`, `hasZoneIdentifier`, and the CIDR constants live in
// `../net-guard/` and are covered by `net-guard.test.ts` as the single source
// of truth. The describes below exercise hardenedFetch's integration with
// those primitives end-to-end (scheme allowlist, DNS validation, error
// wrapping).

describe("hardenedFetch — scheme validation", () => {
	it("rejects file:// scheme", async () => {
		await expect(hardenedFetch("file:///etc/passwd")).rejects.toMatchObject({
			name: "HostBlockedError",
			reason: "bad-scheme",
		});
	});

	it("allows data: scheme (no network egress; delegates to undici)", async () => {
		const res = await hardenedFetch("data:text/plain,hello");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello");
	});

	it("allows data: scheme with base64 encoding", async () => {
		const res = await hardenedFetch("data:text/plain;base64,aGVsbG8=");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello");
	});

	it("rejects ftp: scheme", async () => {
		await expect(hardenedFetch("ftp://example.com/")).rejects.toMatchObject({
			reason: "bad-scheme",
		});
	});

	it("rejects ws: scheme", async () => {
		await expect(hardenedFetch("ws://example.com/")).rejects.toMatchObject({
			reason: "bad-scheme",
		});
	});

	it("rejects javascript: scheme", async () => {
		await expect(hardenedFetch("javascript:alert(1)")).rejects.toMatchObject({
			reason: "bad-scheme",
		});
	});

	it("rejects invalid URLs as TypeError (not a policy block)", async () => {
		// An unparseable URL is a caller error. The handler classifies
		// these as `reason: "network-error"`, not one of the block reasons.
		await expect(hardenedFetch("not a url")).rejects.toBeInstanceOf(TypeError);
	});
});

describe("hardenedFetch — DNS validation", () => {
	it("rejects when DNS returns a private IPv4 (loopback)", async () => {
		mockResolve("127.0.0.1");
		await expect(hardenedFetch("http://internal.local/")).rejects.toMatchObject(
			{
				name: "HostBlockedError",
				reason: "private-ip",
			},
		);
	});

	it("rejects cloud metadata endpoint", async () => {
		mockResolve("169.254.169.254");
		await expect(
			hardenedFetch("http://metadata.attacker.example/latest/meta-data"),
		).rejects.toMatchObject({ reason: "private-ip" });
	});

	it("rejects RFC1918 addresses", async () => {
		mockResolve("10.1.2.3");
		await expect(
			hardenedFetch("http://intranet.example/"),
		).rejects.toMatchObject({ reason: "private-ip" });
	});

	it("rejects IPv4-mapped IPv6 pointing at a private IPv4", async () => {
		mockResolve("::ffff:169.254.169.254", 6);
		await expect(hardenedFetch("http://spoof.example/")).rejects.toMatchObject({
			reason: "private-ip",
		});
	});

	it("rejects IPv6 loopback", async () => {
		mockResolve("::1", 6);
		await expect(hardenedFetch("http://v6.example/")).rejects.toMatchObject({
			reason: "private-ip",
		});
	});

	it("fails closed when DNS returns mixed private+public addresses", async () => {
		mockResolveMany([
			{ address: "10.0.0.1", family: 4 },
			{ address: "8.8.8.8", family: 4 },
		]);
		await expect(hardenedFetch("http://mixed.example/")).rejects.toMatchObject({
			reason: "private-ip",
		});
	});

	// Note: Node's URL parser rejects IPv6 zone identifiers at parse time
	// (`new URL("http://[fe80::1%eth0]/")` throws "Invalid URL"), so a
	// malicious guest cannot reach the connector's zone-id check through a
	// standard URL input. The `hasZoneIdentifier` check stays as
	// defense-in-depth for callers that bypass URL parsing. Direct coverage
	// lives in `../net-guard/net-guard.test.ts`.
});

describe("hardenedFetch — error wrapping", () => {
	it("HostBlockedError has the expected shape", () => {
		const err = new HostBlockedError("private-ip", "nope");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("HostBlockedError");
		expect(err.reason).toBe("private-ip");
		expect(err.message).toBe("nope");
	});

	it("DNS NXDOMAIN surfaces as a non-HostBlockedError", async () => {
		lookup.mockRejectedValueOnce(
			Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" }),
		);
		const err = await hardenedFetch("http://nxdomain.example/").catch((e) => e);
		expect(err).toBeDefined();
		expect(err).not.toBeInstanceOf(HostBlockedError);
	});
});
