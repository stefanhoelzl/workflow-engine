// Shared net-guard primitive for outbound-TCP plugins in sandbox-stdlib.
//
// Exposes the IANA special-use blocklist, a pure address classifier, an
// IPv6 zone-identifier detector, and a DNS-resolution + block-check helper
// used by any plugin that opens TCP sockets from guest-initiated code
// (fetch, mail, and any future outbound-TCP plugin per SECURITY.md §2 R-S4).
//
// Why this is a shared primitive:
//   • single source of truth for the IANA special-use CIDR list — a new
//     reserved RFC range covers every consumer in one edit.
//   • fail-closed behaviour (any blocked resolution = rejection) is uniform.
//   • `assertHostIsPublic` returns a validated IP so callers can hand it
//     to their TCP layer with a servername override, closing the TOCTOU
//     window between validation and connect.

import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

type BlockReason =
	| "bad-scheme"
	| "private-ip"
	| "redirect-to-private"
	| "zone-id";

class HostBlockedError extends Error {
	readonly reason: BlockReason;
	constructor(reason: BlockReason, message: string) {
		super(message);
		this.name = "HostBlockedError";
		this.reason = reason;
	}
}

// IANA special-use CIDRs — explicit list so the spec and code match by
// inspection. Any change here requires updating the spec scenario in
// openspec/specs/sandbox-stdlib/spec.md §net-guard primitive and
// SECURITY.md §2 R-S4.
const BLOCKED_CIDRS_IPV4: readonly string[] = [
	"0.0.0.0/8", // unspecified / "this network"
	"10.0.0.0/8", // RFC1918 private
	"100.64.0.0/10", // CGNAT
	"127.0.0.0/8", // loopback
	"169.254.0.0/16", // link-local / cloud metadata
	"172.16.0.0/12", // RFC1918 private
	"192.0.0.0/24", // IETF protocol assignments
	"192.0.2.0/24", // TEST-NET-1
	"192.88.99.0/24", // 6to4 relay
	"192.168.0.0/16", // RFC1918 private
	"198.18.0.0/15", // benchmark
	"198.51.100.0/24", // TEST-NET-2
	"203.0.113.0/24", // TEST-NET-3
	"224.0.0.0/4", // multicast
	"240.0.0.0/4", // reserved (future use)
	"255.255.255.255/32", // limited broadcast
];

const BLOCKED_CIDRS_IPV6: readonly string[] = [
	"::/128", // unspecified
	"::1/128", // loopback
	"100::/64", // discard-only prefix
	"fc00::/7", // unique-local addresses (ULA)
	"fe80::/10", // link-local
];

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

const PARSED_IPV4_CIDRS: readonly Cidr[] = BLOCKED_CIDRS_IPV4.map((c) =>
	ipaddr.parseCIDR(c),
);
const PARSED_IPV6_CIDRS: readonly Cidr[] = BLOCKED_CIDRS_IPV6.map((c) =>
	ipaddr.parseCIDR(c),
);

function isBlockedAddress(addrStr: string): boolean {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(addrStr);
	} catch {
		// An unparseable address is refused rather than allowed.
		return true;
	}
	// Unwrap IPv4-mapped IPv6 and re-classify as IPv4.
	if (parsed.kind() === "ipv6") {
		const v6 = parsed as ipaddr.IPv6;
		if (v6.isIPv4MappedAddress()) {
			parsed = v6.toIPv4Address();
		}
	}
	if (parsed.kind() === "ipv4") {
		const v4 = parsed as ipaddr.IPv4;
		for (const cidr of PARSED_IPV4_CIDRS) {
			if (v4.match(cidr as [ipaddr.IPv4, number])) {
				return true;
			}
		}
		return false;
	}
	const v6 = parsed as ipaddr.IPv6;
	for (const cidr of PARSED_IPV6_CIDRS) {
		if (v6.match(cidr as [ipaddr.IPv6, number])) {
			return true;
		}
	}
	return false;
}

// URL parsing preserves zone identifiers inside brackets — `new URL("http://
// [fe80::1%eth0]/")` parses with hostname `"[fe80::1%25eth0]"`. Treat any
// percent inside the bracketed literal as a zone id.
function hasZoneIdentifier(hostname: string): boolean {
	return hostname.includes("%");
}

async function assertHostIsPublic(hostname: string): Promise<string> {
	if (hasZoneIdentifier(hostname)) {
		throw new HostBlockedError(
			"zone-id",
			"IPv6 zone identifiers are not permitted",
		);
	}
	// Strip IPv6 brackets for dns.lookup (`[::1]` → `::1`).
	const bare =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	const addresses = await dnsLookup(bare, { all: true });
	if (addresses.length === 0) {
		throw new Error(`dns.lookup returned no addresses for ${hostname}`);
	}
	for (const entry of addresses) {
		if (isBlockedAddress(entry.address)) {
			throw new HostBlockedError(
				"private-ip",
				`${hostname} resolves to a blocked address`,
			);
		}
	}
	const first = addresses[0];
	if (!first) {
		throw new Error(`dns.lookup returned empty list for ${hostname}`);
	}
	return first.address;
}

export type { BlockReason };
export {
	assertHostIsPublic,
	BLOCKED_CIDRS_IPV4,
	BLOCKED_CIDRS_IPV6,
	HostBlockedError,
	hasZoneIdentifier,
	isBlockedAddress,
};
