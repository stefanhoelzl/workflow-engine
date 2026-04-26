// Stops any process holding the local hoodiecrow-imap dev port (3993).
// Useful when a previous `pnpm imap` was backgrounded and not torn down,
// leaving an EADDRINUSE behind.
//
// Invoke: `pnpm imap:kill`. Idempotent — exits 0 when nothing is running.

import { execFileSync } from "node:child_process";

const PORT = 3993;
const TERM_GRACE_MS = 500;

function findPidsOnPort(port: number): readonly string[] {
	const probes = [
		`fuser ${String(port)}/tcp 2>/dev/null`,
		`lsof -ti:${String(port)} 2>/dev/null`,
	];
	for (const cmd of probes) {
		try {
			const out = execFileSync("sh", ["-c", cmd], {
				encoding: "utf-8",
			}).trim();
			const pids = out.match(/\d+/g);
			if (pids && pids.length > 0) {
				return [...new Set(pids)];
			}
		} catch {
			// Probe absent or no match — fall through.
		}
	}
	return [];
}

function sendSignal(pid: string, signal: "TERM" | "KILL"): boolean {
	try {
		execFileSync("kill", [`-${signal}`, pid], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const pids = findPidsOnPort(PORT);
if (pids.length === 0) {
	console.log(`Port ${String(PORT)} is free; nothing to do.`);
	process.exit(0);
}

console.log(
	`Stopping IMAP dev server on port ${String(PORT)} (PIDs: ${pids.join(", ")})…`,
);
for (const pid of pids) {
	sendSignal(pid, "TERM");
}

await new Promise((res) => setTimeout(res, TERM_GRACE_MS));

const stragglers = findPidsOnPort(PORT);
if (stragglers.length > 0) {
	console.log(`Forcing kill (-9) on ${stragglers.join(", ")}…`);
	for (const pid of stragglers) {
		sendSignal(pid, "KILL");
	}
}

const final = findPidsOnPort(PORT);
if (final.length > 0) {
	console.error(
		`Could not free port ${String(PORT)}; PIDs ${final.join(", ")} still listening.`,
	);
	process.exit(1);
}
console.log(`Port ${String(PORT)} is free.`);
