import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock() above imports, so the mock is installed before
// hardened-fetch.ts imports from node:dns/promises. Each test programs the
// `lookup` return via vi.mocked below.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(),
}));

import { lookup as mockLookup } from "node:dns/promises";
import {
	BLOCKED_CIDRS_IPV4,
	BLOCKED_CIDRS_IPV6,
	FetchBlockedError,
	hardenedFetch,
	hasZoneIdentifier,
	isBlockedAddress,
} from "./hardened-fetch.js";

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

describe("isBlockedAddress", () => {
	// Coverage map: one representative per listed CIDR. Keep ordering aligned
	// with the BLOCKED_CIDRS_IPV4 / IPV6 constants for audit readability.
	const IPV4_BLOCKED = [
		["unspecified 0/8", "0.0.0.1"],
		["RFC1918 10/8", "10.1.2.3"],
		["CGNAT 100.64/10", "100.64.0.1"],
		["loopback 127/8", "127.0.0.1"],
		["link-local 169.254/16", "169.254.169.254"],
		["RFC1918 172.16/12", "172.16.0.1"],
		["protocol 192.0.0/24", "192.0.0.1"],
		["TEST-NET-1", "192.0.2.5"],
		["6to4 relay", "192.88.99.1"],
		["RFC1918 192.168/16", "192.168.1.1"],
		["benchmark 198.18/15", "198.18.0.1"],
		["TEST-NET-2", "198.51.100.5"],
		["TEST-NET-3", "203.0.113.5"],
		["multicast 224/4", "224.0.0.1"],
		["reserved 240/4", "240.0.0.1"],
		["broadcast", "255.255.255.255"],
	] as const;

	for (const [label, addr] of IPV4_BLOCKED) {
		it(`blocks ${label} (${addr})`, () => {
			expect(isBlockedAddress(addr)).toBe(true);
		});
	}

	const IPV6_BLOCKED = [
		["unspecified ::", "::"],
		["loopback ::1", "::1"],
		["discard 100::/64", "100::1"],
		["ULA fc00::/7", "fc00::1"],
		["link-local fe80::/10", "fe80::1"],
	] as const;

	for (const [label, addr] of IPV6_BLOCKED) {
		it(`blocks ${label} (${addr})`, () => {
			expect(isBlockedAddress(addr)).toBe(true);
		});
	}

	it("allows public IPv4 8.8.8.8", () => {
		expect(isBlockedAddress("8.8.8.8")).toBe(false);
	});

	it("allows public IPv4 1.1.1.1", () => {
		expect(isBlockedAddress("1.1.1.1")).toBe(false);
	});

	it("allows public IPv6 2606:4700:4700::1111", () => {
		expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
	});

	it("unwraps IPv4-mapped IPv6 and blocks if the IPv4 is private", () => {
		expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
		expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
		expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
	});

	it("unwraps IPv4-mapped IPv6 and allows if the IPv4 is public", () => {
		expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
	});

	it("refuses unparseable addresses", () => {
		expect(isBlockedAddress("not-an-address")).toBe(true);
		expect(isBlockedAddress("")).toBe(true);
	});

	it("exposes the CIDR constants for spec cross-check", () => {
		expect(BLOCKED_CIDRS_IPV4).toContain("169.254.0.0/16");
		expect(BLOCKED_CIDRS_IPV4).toContain("10.0.0.0/8");
		expect(BLOCKED_CIDRS_IPV6).toContain("fe80::/10");
		expect(BLOCKED_CIDRS_IPV6).toContain("::1/128");
	});
});

describe("hasZoneIdentifier", () => {
	it("detects percent-encoded zone ids", () => {
		expect(hasZoneIdentifier("[fe80::1%eth0]")).toBe(true);
		expect(hasZoneIdentifier("[fe80::1%25eth0]")).toBe(true);
	});

	it("passes addresses without zone ids", () => {
		expect(hasZoneIdentifier("example.com")).toBe(false);
		expect(hasZoneIdentifier("[::1]")).toBe(false);
		expect(hasZoneIdentifier("127.0.0.1")).toBe(false);
	});
});

describe("hardenedFetch — scheme validation", () => {
	it("rejects file:// scheme", async () => {
		await expect(hardenedFetch("file:///etc/passwd")).rejects.toMatchObject({
			name: "FetchBlockedError",
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
				name: "FetchBlockedError",
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
	// defense-in-depth for callers that bypass URL parsing. Tested directly
	// in the `hasZoneIdentifier` block above.
});

describe("hardenedFetch — error wrapping", () => {
	it("FetchBlockedError has the expected shape", () => {
		const err = new FetchBlockedError("private-ip", "nope");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("FetchBlockedError");
		expect(err.reason).toBe("private-ip");
		expect(err.message).toBe("nope");
	});

	it("DNS NXDOMAIN surfaces as a non-FetchBlockedError", async () => {
		lookup.mockRejectedValueOnce(
			Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" }),
		);
		const err = await hardenedFetch("http://nxdomain.example/").catch((e) => e);
		expect(err).toBeDefined();
		expect(err).not.toBeInstanceOf(FetchBlockedError);
	});
});
