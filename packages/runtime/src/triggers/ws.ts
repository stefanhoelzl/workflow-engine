import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
	OWNER_NAME_RE,
	REPO_NAME_RE,
	TRIGGER_NAME_RE,
} from "@workflow-engine/core";
import { type WebSocket, WebSocketServer } from "ws";
import { isMember } from "../auth/owner.js";
import type { ProviderRegistry } from "../auth/providers/index.js";
import type { AuthProvider } from "../auth/providers/types.js";
import type { UserContext } from "../auth/user-context.js";
import type { WsTriggerDescriptor } from "../executor/types.js";
import type { Logger } from "../logger.js";
import type {
	ReconfigureResult,
	TriggerEntry,
	TriggerSource,
	UpgradeProvider,
} from "./source.js";

// ---------------------------------------------------------------------------
// WS TriggerSource (and UpgradeProvider)
// ---------------------------------------------------------------------------
//
// Implements both contracts:
//   - TriggerSource<"ws">: receives `reconfigure(owner, repo, entries)` from
//     the WorkflowRegistry on every repo upload; tracks (owner, repo, workflow,
//     trigger) → entry; on reconfigure, force-closes any open connection
//     whose trigger no longer exists with code 1012.
//   - UpgradeProvider: owns a `WebSocketServer({noServer:true})`; the http
//     server's `'upgrade'` event handler runs the auth + routing pipeline,
//     then delegates to `wss.handleUpgrade` on success or writes a uniform
//     `404` on failure.
//
// Wire contract:
//   - URL: /ws/<owner>/<repo>/<workflow>/<trigger>
//   - Auth: `Authorization: Bearer <token>` + `X-Auth-Provider: <id>` headers
//     on the upgrade request. Same code path as `apiAuthMiddleware` (provider
//     registry resolves identity from the request).
//   - Frame format: text frame, JSON-parsed; `data` validated against the
//     trigger's `request` zod schema by `entry.fire`.
//   - Reply: handler return is JSON-serialized and sent as a single text
//     frame back to the originating client.
//   - Close codes: 1007 (bad inbound), 1011 (handler/output failure), 1012
//     (reconfigure removes trigger), 1001 (server stop).
//
// Heartbeat: pingInterval=30s; per-socket isAlive flag; missed pong →
// `ws.terminate()`.

const PROVIDER_HEADER = "x-auth-provider";
const URL_PREFIX = "/ws/";
const URL_SEGMENT_COUNT = 4;
const WS_PING_INTERVAL_MS = 30_000;

const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_GOING_AWAY = 1001;
const WS_CLOSE_INVALID_PAYLOAD = 1007;
const WS_CLOSE_SERVER_ERROR = 1011;
const WS_CLOSE_SERVICE_RESTART = 1012;

const NOT_FOUND_RESPONSE =
	"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

interface WsTriggerSourceDeps {
	readonly logger: Logger;
	readonly authRegistry: ProviderRegistry;
}

interface WsTriggerSource
	extends TriggerSource<"ws", WsTriggerDescriptor>,
		UpgradeProvider {}

interface ScopeKey {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly trigger: string;
}

interface RegisteredConnection {
	readonly ws: WebSocket;
	readonly scope: ScopeKey;
	readonly entry: TriggerEntry<WsTriggerDescriptor>;
	isAlive: boolean;
}

type RejectReason =
	| "not-an-upgrade"
	| "bad-path"
	| "missing-authorization"
	| "missing-provider"
	| "bad-bearer"
	| "owner-not-member"
	| "trigger-not-found"
	| "trigger-wrong-kind";

function pairKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
}

function entryKey(workflow: string, trigger: string): string {
	return `${workflow}/${trigger}`;
}

function rejectUpgrade(socket: Duplex): void {
	try {
		socket.write(NOT_FOUND_RESPONSE);
	} catch {
		// socket may already be torn down; ignore
	}
	socket.destroy();
}

// Build a Web `Request` from the Node IncomingMessage so existing providers'
// `resolveApiIdentity(req: Request)` can read headers via `req.headers.get(...)`
// without rewiring. Body is empty (upgrade requests have no body).
function buildRequestFromUpgrade(req: IncomingMessage): Request {
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) {
			continue;
		}
		if (Array.isArray(v)) {
			for (const item of v) {
				headers.append(k, item);
			}
		} else {
			headers.set(k, v);
		}
	}
	// URL needed but not used by providers — synthesize a minimal valid one.
	const host = req.headers.host ?? "localhost";
	const url = `http://${host}${req.url ?? "/"}`;
	return new Request(url, { method: req.method ?? "GET", headers });
}

function parseScopeFromUrl(url: string | undefined): ScopeKey | undefined {
	if (!url) {
		return;
	}
	const queryIndex = url.indexOf("?");
	const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
	if (!path.startsWith(URL_PREFIX)) {
		return;
	}
	const rest = path.slice(URL_PREFIX.length);
	const segments = rest.split("/");
	if (segments.length !== URL_SEGMENT_COUNT) {
		return;
	}
	const [owner, repo, workflow, trigger] = segments as [
		string,
		string,
		string,
		string,
	];
	if (!OWNER_NAME_RE.test(owner)) {
		return;
	}
	if (!REPO_NAME_RE.test(repo)) {
		return;
	}
	if (!TRIGGER_NAME_RE.test(workflow)) {
		return;
	}
	if (!TRIGGER_NAME_RE.test(trigger)) {
		return;
	}
	return { owner, repo, workflow, trigger };
}

function isUpgradeRequest(req: IncomingMessage): boolean {
	const upgrade = req.headers.upgrade;
	if (!upgrade) {
		return false;
	}
	return String(upgrade).toLowerCase() === "websocket";
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups the connection registry, upgrade pipeline, message dispatch, heartbeat, reconfigure, and TriggerSource lifecycle — splitting fragments cohesion of the per-source state machine
function createWsTriggerSource(deps: WsTriggerSourceDeps): WsTriggerSource {
	const wss = new WebSocketServer({ noServer: true });

	// Per-(owner, repo) entry index. Outer key is "owner/repo" so reconfigure
	// only touches that pair's entries. Inner key is "workflow/trigger".
	const entries = new Map<
		string,
		Map<string, TriggerEntry<WsTriggerDescriptor>>
	>();

	// Live connection registry. Same outer key as `entries` so reconfigure
	// can find connections under a (owner, repo) cheaply.
	const connectionsByPair = new Map<string, Set<RegisteredConnection>>();

	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;

	function logReject(scope: ScopeKey | undefined, reason: RejectReason): void {
		deps.logger.warn("ws.upgrade-rejected", {
			reason,
			...(scope
				? {
						owner: scope.owner,
						repo: scope.repo,
						workflow: scope.workflow,
						trigger: scope.trigger,
					}
				: {}),
		});
	}

	function lookupEntry(
		scope: ScopeKey,
	): TriggerEntry<WsTriggerDescriptor> | undefined {
		return entries
			.get(pairKey(scope.owner, scope.repo))
			?.get(entryKey(scope.workflow, scope.trigger));
	}

	function registerConnection(conn: RegisteredConnection): void {
		const key = pairKey(conn.scope.owner, conn.scope.repo);
		let set = connectionsByPair.get(key);
		if (!set) {
			set = new Set();
			connectionsByPair.set(key, set);
		}
		set.add(conn);
	}

	function unregisterConnection(conn: RegisteredConnection): void {
		const key = pairKey(conn.scope.owner, conn.scope.repo);
		connectionsByPair.get(key)?.delete(conn);
	}

	function frameToText(frame: Buffer | ArrayBuffer | Buffer[]): string {
		if (Buffer.isBuffer(frame)) {
			return frame.toString("utf-8");
		}
		if (Array.isArray(frame)) {
			return Buffer.concat(frame).toString("utf-8");
		}
		return Buffer.from(frame).toString("utf-8");
	}

	function sendReply(conn: RegisteredConnection, output: unknown): void {
		try {
			conn.ws.send(JSON.stringify(output));
		} catch (err) {
			deps.logger.error("ws.send-failed", {
				error: err instanceof Error ? err.message : String(err),
				...conn.scope,
			});
			conn.ws.close(WS_CLOSE_SERVER_ERROR, "send failed");
		}
	}

	async function dispatchFrame(
		conn: RegisteredConnection,
		frame: Buffer | ArrayBuffer | Buffer[],
		isBinary: boolean,
	): Promise<void> {
		if (isBinary) {
			conn.ws.close(WS_CLOSE_INVALID_PAYLOAD, "binary frame");
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(frameToText(frame));
		} catch {
			conn.ws.close(WS_CLOSE_INVALID_PAYLOAD, "json parse");
			return;
		}
		const result = await conn.entry.fire({ data: parsed }, { source: "ws" });
		if (conn.ws.readyState !== conn.ws.OPEN) {
			return;
		}
		if (result.ok) {
			sendReply(conn, result.output);
			return;
		}
		// Failure path. If `fire` reports validation issues, the input failed
		// the trigger's `request` zod schema → wire-level invalid payload.
		// Otherwise (handler throw, output validation failure) → server error.
		if (result.error.issues === undefined) {
			conn.ws.close(WS_CLOSE_SERVER_ERROR, "handler");
		} else {
			conn.ws.close(WS_CLOSE_INVALID_PAYLOAD, "schema");
		}
	}

	function onConnection(
		ws: WebSocket,
		scope: ScopeKey,
		entry: TriggerEntry<WsTriggerDescriptor>,
	): void {
		const conn: RegisteredConnection = { ws, scope, entry, isAlive: true };
		registerConnection(conn);
		ws.on("pong", () => {
			conn.isAlive = true;
		});
		ws.on("message", (frame, isBinary) => {
			dispatchFrame(conn, frame, isBinary).catch((err) => {
				deps.logger.error("ws.dispatch-threw", {
					error: err instanceof Error ? err.message : String(err),
					...scope,
				});
				if (ws.readyState === ws.OPEN) {
					ws.close(WS_CLOSE_SERVER_ERROR, "dispatch");
				}
			});
		});
		ws.on("close", () => {
			unregisterConnection(conn);
		});
		ws.on("error", (err) => {
			deps.logger.warn("ws.socket-error", {
				error: err.message,
				...scope,
			});
		});
	}

	type SyncCheck =
		| { ok: true; scope: ScopeKey; provider: AuthProvider }
		| { ok: false; scope: ScopeKey | undefined; reason: RejectReason }
		| { ok: false; passThrough: true };

	function preauthChecks(req: IncomingMessage): SyncCheck {
		// (1) Path match. Even if the URL doesn't match `/ws/...` the http
		// server may have routed the upgrade event to us; bail without
		// destroying so any other upgrade listener can try.
		if (!req.url?.startsWith(URL_PREFIX)) {
			return { ok: false, passThrough: true };
		}
		const scope = parseScopeFromUrl(req.url);
		if (!scope) {
			return { ok: false, scope: undefined, reason: "bad-path" };
		}
		if (!isUpgradeRequest(req)) {
			return { ok: false, scope, reason: "not-an-upgrade" };
		}
		const providerId = req.headers[PROVIDER_HEADER];
		if (typeof providerId !== "string" || providerId === "") {
			return { ok: false, scope, reason: "missing-provider" };
		}
		const provider = deps.authRegistry.byId(providerId);
		if (!provider) {
			return { ok: false, scope, reason: "missing-provider" };
		}
		const auth = req.headers.authorization;
		if (typeof auth !== "string" || auth === "") {
			return { ok: false, scope, reason: "missing-authorization" };
		}
		return { ok: true, scope, provider };
	}

	function postAuthChecks(
		scope: ScopeKey,
		user: UserContext | undefined,
	): { ok: true; entry: TriggerEntry<WsTriggerDescriptor> } | RejectReason {
		if (!user) {
			return "bad-bearer";
		}
		if (!isMember(user, scope.owner)) {
			return "owner-not-member";
		}
		const entry = lookupEntry(scope);
		if (!entry) {
			return "trigger-not-found";
		}
		if (entry.descriptor.kind !== "ws") {
			return "trigger-wrong-kind";
		}
		return { ok: true, entry };
	}

	function upgradeHandler(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	): void {
		const pre = preauthChecks(req);
		if (!pre.ok) {
			if ("passThrough" in pre) {
				return;
			}
			logReject(pre.scope, pre.reason);
			rejectUpgrade(socket);
			return;
		}
		const { scope, provider } = pre;
		const wrappedReq = buildRequestFromUpgrade(req);
		provider
			.resolveApiIdentity(wrappedReq)
			.then((user) => {
				const post = postAuthChecks(scope, user);
				if (typeof post === "string") {
					logReject(scope, post);
					rejectUpgrade(socket);
					return;
				}
				wss.handleUpgrade(req, socket, head, (ws) => {
					onConnection(ws, scope, post.entry);
				});
			})
			.catch((err) => {
				deps.logger.error("ws.auth-resolve-threw", {
					error: err instanceof Error ? err.message : String(err),
					...scope,
				});
				rejectUpgrade(socket);
			});
	}

	function tickConnection(conn: RegisteredConnection): void {
		if (!conn.isAlive) {
			conn.ws.terminate();
			unregisterConnection(conn);
			return;
		}
		conn.isAlive = false;
		try {
			conn.ws.ping();
		} catch {
			// socket may be in a transient state; the next tick terminates if
			// truly dead.
		}
	}

	function heartbeatTick(): void {
		for (const set of connectionsByPair.values()) {
			for (const conn of set) {
				tickConnection(conn);
			}
		}
	}

	function startHeartbeat(): void {
		if (heartbeatTimer !== undefined) {
			return;
		}
		heartbeatTimer = setInterval(heartbeatTick, WS_PING_INTERVAL_MS);
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer !== undefined) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	}

	function evictMissingConnections(
		key: string,
		newMap: Map<string, TriggerEntry<WsTriggerDescriptor>>,
	): void {
		const conns = connectionsByPair.get(key);
		if (!conns) {
			return;
		}
		for (const conn of [...conns]) {
			const stillThere = newMap.get(
				entryKey(conn.scope.workflow, conn.scope.trigger),
			);
			if (!stillThere) {
				conn.ws.close(WS_CLOSE_SERVICE_RESTART, "service restart");
				unregisterConnection(conn);
			}
		}
	}

	function reconfigure(
		owner: string,
		repo: string,
		newEntries: readonly TriggerEntry<WsTriggerDescriptor>[],
	): Promise<ReconfigureResult> {
		if (stopped) {
			return Promise.resolve({ ok: true });
		}
		const key = pairKey(owner, repo);
		const newMap = new Map<string, TriggerEntry<WsTriggerDescriptor>>();
		for (const entry of newEntries) {
			newMap.set(
				entryKey(entry.descriptor.workflowName, entry.descriptor.name),
				entry,
			);
		}
		evictMissingConnections(key, newMap);
		if (newMap.size === 0) {
			entries.delete(key);
		} else {
			entries.set(key, newMap);
			startHeartbeat();
		}
		return Promise.resolve({ ok: true });
	}

	function stop(): Promise<void> {
		stopped = true;
		stopHeartbeat();
		for (const set of connectionsByPair.values()) {
			for (const conn of set) {
				try {
					conn.ws.close(WS_CLOSE_GOING_AWAY, "going away");
				} catch {
					// ignore; socket may already be torn down
				}
			}
		}
		connectionsByPair.clear();
		entries.clear();
		try {
			wss.close();
		} catch {
			// ignore
		}
		return Promise.resolve();
	}

	return {
		kind: "ws",
		pingInterval: WS_PING_INTERVAL_MS,
		start() {
			return Promise.resolve();
		},
		stop,
		reconfigure,
		upgradeHandler,
	};
}

export type { WsTriggerSource };
export {
	createWsTriggerSource,
	isUpgradeRequest,
	NOT_FOUND_RESPONSE,
	parseScopeFromUrl,
	WS_CLOSE_GOING_AWAY,
	WS_CLOSE_INVALID_PAYLOAD,
	WS_CLOSE_NORMAL,
	WS_CLOSE_SERVER_ERROR,
	WS_CLOSE_SERVICE_RESTART,
	WS_PING_INTERVAL_MS,
};
