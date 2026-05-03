import { lookup as mockLookup } from "node:dns/promises";
import { vi } from "vitest";

// Each test file MUST install the mock module-globally before importing
// helpers from this file:
//
//   vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
//
// `vi.mock` is hoisted file-locally and does not transfer across imports,
// so the directive cannot live here. Once the mock is installed, this
// helper exposes a typed handle (`dnsLookup`) and a few convenience setters
// for the most-common shapes.

// `dns.promises.lookup` has two overloads (single address vs array). The
// `vi.mocked` default picks the single-address shape; cast through unknown
// to expose the array-returning shape `assertHostIsPublic` calls (with
// `{ all: true }`).
const dnsLookup = vi.mocked(mockLookup) as unknown as {
	mockResolvedValueOnce: (
		value: Array<{ address: string; family: 4 | 6 }>,
	) => void;
	mockRejectedValueOnce: (err: unknown) => void;
	mockReset: () => void;
};

function mockResolveOnce(
	addrs: Array<{ address: string; family: 4 | 6 }>,
): void {
	dnsLookup.mockResolvedValueOnce(addrs);
}

function mockResolveAddress(addr: string, family: 4 | 6 = 4): void {
	dnsLookup.mockResolvedValueOnce([{ address: addr, family }]);
}

function mockPublicHost(addr = "93.184.216.34"): void {
	dnsLookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
}

function mockPrivateHost(addr = "10.0.0.1"): void {
	dnsLookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
}

function mockRejectOnce(err: unknown): void {
	dnsLookup.mockRejectedValueOnce(err);
}

function resetDnsMock(): void {
	dnsLookup.mockReset();
}

export {
	dnsLookup,
	mockPrivateHost,
	mockPublicHost,
	mockRejectOnce,
	mockResolveAddress,
	mockResolveOnce,
	resetDnsMock,
};
