import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(),
}));

import { lookup as mockLookup } from "node:dns/promises";
import {
	assertHostIsPublic,
	HostBlockedError,
	hasZoneIdentifier,
	isBlockedAddress,
} from "./index.js";

const lookup = vi.mocked(mockLookup) as unknown as {
	mockResolvedValueOnce: (
		value: Array<{ address: string; family: 4 | 6 }>,
	) => void;
	mockReset: () => void;
};

beforeEach(() => {
	lookup.mockReset();
});

describe("net-guard — isBlockedAddress", () => {
	it("blocks RFC1918 10.0.0.0/8", () => {
		expect(isBlockedAddress("10.0.0.1")).toBe(true);
	});

	it("blocks RFC1918 172.16.0.0/12", () => {
		expect(isBlockedAddress("172.16.5.5")).toBe(true);
	});

	it("blocks RFC1918 192.168.0.0/16", () => {
		expect(isBlockedAddress("192.168.1.1")).toBe(true);
	});

	it("blocks loopback 127.0.0.0/8", () => {
		expect(isBlockedAddress("127.0.0.1")).toBe(true);
	});

	it("blocks link-local / metadata 169.254.0.0/16", () => {
		expect(isBlockedAddress("169.254.169.254")).toBe(true);
	});

	it("blocks IPv6 loopback ::1", () => {
		expect(isBlockedAddress("::1")).toBe(true);
	});

	it("blocks IPv6 ULA fc00::/7", () => {
		expect(isBlockedAddress("fc00::1")).toBe(true);
	});

	it("blocks IPv6 link-local fe80::/10", () => {
		expect(isBlockedAddress("fe80::1")).toBe(true);
	});

	it("blocks IPv4-mapped IPv6 pointing at a private IPv4", () => {
		expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
	});

	it("allows public IPv4", () => {
		expect(isBlockedAddress("8.8.8.8")).toBe(false);
	});

	it("allows public IPv6", () => {
		expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
	});

	it("treats an unparseable address as blocked (fail-closed)", () => {
		expect(isBlockedAddress("not an ip")).toBe(true);
	});
});

describe("net-guard — hasZoneIdentifier", () => {
	it("detects a percent in the hostname", () => {
		expect(hasZoneIdentifier("[fe80::1%eth0]")).toBe(true);
	});

	it("returns false for plain hostnames", () => {
		expect(hasZoneIdentifier("example.com")).toBe(false);
		expect(hasZoneIdentifier("[::1]")).toBe(false);
		expect(hasZoneIdentifier("127.0.0.1")).toBe(false);
	});
});

describe("net-guard — assertHostIsPublic", () => {
	it("rejects a hostname resolving to RFC-1918 with reason private-ip", async () => {
		lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
		const err = await assertHostIsPublic("internal.example").catch((e) => e);
		expect(err).toBeInstanceOf(HostBlockedError);
		expect((err as HostBlockedError).reason).toBe("private-ip");
	});

	it("rejects IPv6 zone-identifier hostnames with reason zone-id", async () => {
		const err = await assertHostIsPublic("[fe80::1%eth0]").catch((e) => e);
		expect(err).toBeInstanceOf(HostBlockedError);
		expect((err as HostBlockedError).reason).toBe("zone-id");
	});

	it("returns the first validated IP on success", async () => {
		lookup.mockResolvedValueOnce([
			{ address: "1.2.3.4", family: 4 },
			{ address: "5.6.7.8", family: 4 },
		]);
		const chosen = await assertHostIsPublic("public.example");
		expect(chosen).toBe("1.2.3.4");
	});

	it("fails closed when DNS returns mixed private+public addresses", async () => {
		lookup.mockResolvedValueOnce([
			{ address: "1.2.3.4", family: 4 },
			{ address: "10.0.0.1", family: 4 },
		]);
		const err = await assertHostIsPublic("mixed.example").catch((e) => e);
		expect(err).toBeInstanceOf(HostBlockedError);
		expect((err as HostBlockedError).reason).toBe("private-ip");
	});

	it("rejects when DNS returns an empty list", async () => {
		lookup.mockResolvedValueOnce([]);
		await expect(assertHostIsPublic("empty.example")).rejects.toThrow(
			/no addresses/,
		);
	});

	it("strips IPv6 brackets before calling dns.lookup", async () => {
		lookup.mockResolvedValueOnce([
			{ address: "2606:4700:4700::1111", family: 6 },
		]);
		const chosen = await assertHostIsPublic("[cloudflare.example]");
		expect(chosen).toBe("2606:4700:4700::1111");
	});
});
