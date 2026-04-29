import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { ProviderRegistry } from "../auth/providers/index.js";
import type { AuthProvider } from "../auth/providers/types.js";
import type { UserContext } from "../auth/user-context.js";
import type { InvokeResult, WsTriggerDescriptor } from "../executor/types.js";
import { createLogger } from "../logger.js";
import type { TriggerEntry } from "./source.js";
import { withZodSchemas } from "./test-descriptors.js";
import {
	createWsTriggerSource,
	isUpgradeRequest,
	NOT_FOUND_RESPONSE,
	parseScopeFromUrl,
	WS_CLOSE_INVALID_PAYLOAD,
	WS_CLOSE_SERVER_ERROR,
	WS_CLOSE_SERVICE_RESTART,
	type WsTriggerSource,
} from "./ws.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger() {
	return createLogger("test", { level: "silent" });
}

function makeUser(login: string, orgs: string[]): UserContext {
	return {
		provider: "local",
		login,
		mail: `${login}@x.test`,
		orgs,
	} as UserContext;
}

function makeAuthRegistry(opts: {
	resolves?: UserContext | undefined;
	throws?: Error;
}): ProviderRegistry {
	const provider = {
		id: "local",
		resolveApiIdentity: vi
			.fn<AuthProvider["resolveApiIdentity"]>()
			.mockImplementation(async () => {
				if (opts.throws) {
					throw opts.throws;
				}
				return opts.resolves;
			}),
	} as unknown as AuthProvider;
	return {
		providers: [provider],
		byId: vi.fn((id: string) => (id === "local" ? provider : undefined)),
	} as unknown as ProviderRegistry;
}

function makeWsDescriptor(
	overrides: Partial<WsTriggerDescriptor> = {},
): WsTriggerDescriptor {
	return withZodSchemas({
		kind: "ws" as const,
		type: "ws" as const,
		name: "echo",
		workflowName: "wf",
		request: {
			type: "object",
			properties: { greet: { type: "string" } },
			required: ["greet"],
			additionalProperties: false,
		},
		response: {},
		inputSchema: {
			type: "object",
			properties: {
				data: {
					type: "object",
					properties: { greet: { type: "string" } },
					required: ["greet"],
					additionalProperties: false,
				},
			},
			required: ["data"],
			additionalProperties: false,
		},
		outputSchema: {},
		...overrides,
	});
}

type Fire = (
	input: unknown,
	dispatch?: { source: string },
) => Promise<InvokeResult<unknown>>;

function makeEntry(
	descriptor: WsTriggerDescriptor,
	fire?: Fire,
): TriggerEntry<WsTriggerDescriptor> & { fire: ReturnType<typeof vi.fn> } {
	const fireMock = vi.fn<Fire>(
		fire ??
			(async (input: unknown) => {
				// minimal validating fire: ensure data has a `greet` string
				const d = (input as { data?: { greet?: unknown } }).data;
				if (!d || typeof d.greet !== "string") {
					return {
						ok: false as const,
						error: {
							message: "validation",
							issues: [{ path: ["data", "greet"], message: "required" }],
						},
					};
				}
				return { ok: true as const, output: { echo: d.greet } };
			}),
	);
	return {
		descriptor,
		fire: fireMock,
		exception: vi.fn(async () => undefined),
	};
}

interface Bound {
	source: WsTriggerSource;
	server: Server;
	port: number;
	close: () => Promise<void>;
}

async function bind(source: WsTriggerSource): Promise<Bound> {
	const server = createHttpServer();
	server.on("upgrade", (req, socket, head) => {
		source.upgradeHandler(req, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		source,
		server,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

async function rawSocketProbe(
	port: number,
	rawRequest: string,
): Promise<{ statusLine: string; raw: string }> {
	const net = await import("node:net");
	return await new Promise((resolve, reject) => {
		const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
			sock.write(rawRequest);
		});
		let buf = "";
		sock.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
		});
		sock.on("end", () => {
			const statusLine = buf.split("\r\n")[0] ?? "";
			resolve({ statusLine, raw: buf });
		});
		sock.on("error", reject);
	});
}

interface WsClientHandle {
	client: WsClient;
	closed: Promise<{ code: number; reason: string }>;
}

function openClient(
	port: number,
	path: string,
	headers: Record<string, string>,
): WsClientHandle {
	const client = new WsClient(`ws://127.0.0.1:${port}${path}`, {
		headers,
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		client.on("close", (code, reason) => {
			resolve({ code, reason: reason.toString() });
		});
		client.on("error", () => {
			// swallow; close will fire too
		});
	});
	return { client, closed };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseScopeFromUrl", () => {
	it("parses a four-segment path", () => {
		expect(parseScopeFromUrl("/ws/local/demo/wf/echo")).toEqual({
			owner: "local",
			repo: "demo",
			workflow: "wf",
			trigger: "echo",
		});
	});

	it("rejects wrong prefix", () => {
		expect(parseScopeFromUrl("/api/local/demo/wf/echo")).toBeUndefined();
	});

	it("rejects wrong segment count", () => {
		expect(parseScopeFromUrl("/ws/local/demo/wf")).toBeUndefined();
		expect(parseScopeFromUrl("/ws/local/demo/wf/echo/extra")).toBeUndefined();
	});

	it("rejects invalid owner / repo / trigger names", () => {
		expect(parseScopeFromUrl("/ws/$bad/demo/wf/echo")).toBeUndefined();
		expect(parseScopeFromUrl("/ws/local/!bad/wf/echo")).toBeUndefined();
		expect(parseScopeFromUrl("/ws/local/demo/9wf/echo")).toBeUndefined();
		expect(parseScopeFromUrl("/ws/local/demo/wf/$echo")).toBeUndefined();
	});

	it("strips query string before parsing", () => {
		expect(parseScopeFromUrl("/ws/local/demo/wf/echo?x=1")).toEqual({
			owner: "local",
			repo: "demo",
			workflow: "wf",
			trigger: "echo",
		});
	});
});

describe("isUpgradeRequest", () => {
	it("matches 'websocket' case-insensitively", () => {
		expect(
			isUpgradeRequest({ headers: { upgrade: "websocket" } } as never),
		).toBe(true);
		expect(
			isUpgradeRequest({ headers: { upgrade: "WebSocket" } } as never),
		).toBe(true);
	});
	it("rejects missing or other upgrade values", () => {
		expect(isUpgradeRequest({ headers: {} } as never)).toBe(false);
		expect(isUpgradeRequest({ headers: { upgrade: "h2c" } } as never)).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// Upgrade rejection (fail-closed 404)
// ---------------------------------------------------------------------------

describe("upgradeHandler rejection paths", () => {
	let bound: Bound;

	beforeEach(async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({ resolves: undefined }),
		});
		bound = await bind(source);
	});

	afterEach(async () => {
		await bound.source.stop();
		await bound.close();
	});

	it("plain GET (no Upgrade header) → 404 wire response", async () => {
		// Note: when there's no Upgrade header, the http server doesn't fire
		// 'upgrade'; the request goes through normal request handling. Without
		// a request handler the server hangs the request. Skip this case at
		// the unit level — covered by "non-upgrade GET → 404" only via the
		// upgrade event when a misbehaving client sends Upgrade with non-ws
		// value.
		const res = await rawSocketProbe(
			bound.port,
			"GET /ws/local/demo/wf/echo HTTP/1.1\r\nHost: localhost\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n",
		);
		expect(res.statusLine).toContain("404");
	});

	it("missing Authorization → 404", async () => {
		const res = await rawSocketProbe(
			bound.port,
			[
				"GET /ws/local/demo/wf/echo HTTP/1.1",
				"Host: localhost",
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Version: 13",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"X-Auth-Provider: local",
				"",
				"",
			].join("\r\n"),
		);
		expect(res.raw).toBe(NOT_FOUND_RESPONSE);
	});

	it("missing X-Auth-Provider → 404", async () => {
		const res = await rawSocketProbe(
			bound.port,
			[
				"GET /ws/local/demo/wf/echo HTTP/1.1",
				"Host: localhost",
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Version: 13",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"Authorization: Bearer xyz",
				"",
				"",
			].join("\r\n"),
		);
		expect(res.raw).toBe(NOT_FOUND_RESPONSE);
	});

	it("bad path → 404", async () => {
		const res = await rawSocketProbe(
			bound.port,
			[
				"GET /ws/$bad/demo/wf/echo HTTP/1.1",
				"Host: localhost",
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Version: 13",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"Authorization: Bearer xyz",
				"X-Auth-Provider: local",
				"",
				"",
			].join("\r\n"),
		);
		expect(res.raw).toBe(NOT_FOUND_RESPONSE);
	});
});

describe("upgradeHandler authenticated rejections", () => {
	it("user not member → 404", async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({
				resolves: makeUser("alice", ["other"]),
			}),
		});
		const b = await bind(source);
		try {
			const res = await rawSocketProbe(
				b.port,
				[
					"GET /ws/acme/private/wf/echo HTTP/1.1",
					"Host: localhost",
					"Upgrade: websocket",
					"Connection: Upgrade",
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Authorization: Bearer xyz",
					"X-Auth-Provider: local",
					"",
					"",
				].join("\r\n"),
			);
			expect(res.raw).toBe(NOT_FOUND_RESPONSE);
		} finally {
			await source.stop();
			await b.close();
		}
	});

	it("trigger not registered → 404", async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({
				resolves: makeUser("alice", ["acme"]),
			}),
		});
		const b = await bind(source);
		try {
			const res = await rawSocketProbe(
				b.port,
				[
					"GET /ws/acme/repo/wf/missing HTTP/1.1",
					"Host: localhost",
					"Upgrade: websocket",
					"Connection: Upgrade",
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Authorization: Bearer xyz",
					"X-Auth-Provider: local",
					"",
					"",
				].join("\r\n"),
			);
			expect(res.raw).toBe(NOT_FOUND_RESPONSE);
		} finally {
			await source.stop();
			await b.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Accepted upgrade + dispatch
// ---------------------------------------------------------------------------

describe("upgradeHandler accepted + dispatch", () => {
	let bound: Bound;
	let entry: ReturnType<typeof makeEntry>;

	beforeEach(async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({
				resolves: makeUser("alice", ["acme"]),
			}),
		});
		entry = makeEntry(makeWsDescriptor());
		await source.reconfigure("acme", "repo", [entry]);
		bound = await bind(source);
	});

	afterEach(async () => {
		await bound.source.stop();
		await bound.close();
	});

	it("happy path: send → reply, connection stays open", async () => {
		const { client, closed } = openClient(bound.port, "/ws/acme/repo/wf/echo", {
			Authorization: "Bearer xyz",
			"X-Auth-Provider": "local",
		});
		await new Promise<void>((resolve) => client.once("open", () => resolve()));
		const reply = new Promise<unknown>((resolve) => {
			client.once("message", (data) => resolve(JSON.parse(data.toString())));
		});
		client.send(JSON.stringify({ greet: "hi" }));
		expect(await reply).toEqual({ echo: "hi" });
		expect(client.readyState).toBe(WsClient.OPEN);
		client.close();
		await closed;
	});

	it("bad JSON → 1007 close", async () => {
		const { client, closed } = openClient(bound.port, "/ws/acme/repo/wf/echo", {
			Authorization: "Bearer xyz",
			"X-Auth-Provider": "local",
		});
		await new Promise<void>((resolve) => client.once("open", () => resolve()));
		client.send("not json");
		const r = await closed;
		expect(r.code).toBe(WS_CLOSE_INVALID_PAYLOAD);
	});

	it("schema-violating JSON → 1007 close (via fire returning issues)", async () => {
		const { client, closed } = openClient(bound.port, "/ws/acme/repo/wf/echo", {
			Authorization: "Bearer xyz",
			"X-Auth-Provider": "local",
		});
		await new Promise<void>((resolve) => client.once("open", () => resolve()));
		client.send(JSON.stringify({ greet: 42 }));
		const r = await closed;
		expect(r.code).toBe(WS_CLOSE_INVALID_PAYLOAD);
	});

	it("handler throws → 1011 close", async () => {
		// Replace the entry's fire to simulate handler throw (no issues).
		await bound.source.reconfigure("acme", "repo", [
			{
				...entry,
				fire: vi.fn(async () => ({
					ok: false as const,
					error: { message: "handler boom" },
				})),
			},
		]);
		const { client, closed } = openClient(bound.port, "/ws/acme/repo/wf/echo", {
			Authorization: "Bearer xyz",
			"X-Auth-Provider": "local",
		});
		await new Promise<void>((resolve) => client.once("open", () => resolve()));
		client.send(JSON.stringify({ greet: "hi" }));
		const r = await closed;
		expect(r.code).toBe(WS_CLOSE_SERVER_ERROR);
	});

	it("FIFO reply order across N pipelined frames", async () => {
		// Make fire deterministically resolve in arrival order.
		await bound.source.reconfigure("acme", "repo", [
			{
				...entry,
				fire: vi.fn(async (input: unknown) => ({
					ok: true as const,
					output: { seq: (input as { data: { seq: number } }).data.seq },
				})),
			} as TriggerEntry<WsTriggerDescriptor>,
		]);
		const { client, closed } = openClient(bound.port, "/ws/acme/repo/wf/echo", {
			Authorization: "Bearer xyz",
			"X-Auth-Provider": "local",
		});
		await new Promise<void>((resolve) => client.once("open", () => resolve()));
		const replies: number[] = [];
		const want = 5;
		const done = new Promise<void>((resolve) => {
			client.on("message", (data) => {
				const obj = JSON.parse(data.toString()) as { seq: number };
				replies.push(obj.seq);
				if (replies.length === want) {
					resolve();
				}
			});
		});
		for (let i = 0; i < want; i++) {
			client.send(JSON.stringify({ seq: i }));
		}
		await done;
		expect(replies).toEqual([0, 1, 2, 3, 4]);
		client.close();
		await closed;
	});
});

// ---------------------------------------------------------------------------
// Reconfigure 1012 + stop 1001
// ---------------------------------------------------------------------------

describe("reconfigure + stop", () => {
	it("reconfigure removing the trigger force-closes existing connections (1012)", async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({
				resolves: makeUser("alice", ["acme"]),
			}),
		});
		const entry = makeEntry(makeWsDescriptor());
		await source.reconfigure("acme", "repo", [entry]);
		const b = await bind(source);
		try {
			const { client, closed } = openClient(b.port, "/ws/acme/repo/wf/echo", {
				Authorization: "Bearer xyz",
				"X-Auth-Provider": "local",
			});
			await new Promise<void>((resolve) =>
				client.once("open", () => resolve()),
			);
			// remove the trigger
			await source.reconfigure("acme", "repo", []);
			const r = await closed;
			expect(r.code).toBe(WS_CLOSE_SERVICE_RESTART);
		} finally {
			await source.stop();
			await b.close();
		}
	});

	it("reconfigure keeping the trigger leaves connections open", async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({
				resolves: makeUser("alice", ["acme"]),
			}),
		});
		const entry = makeEntry(makeWsDescriptor());
		await source.reconfigure("acme", "repo", [entry]);
		const b = await bind(source);
		try {
			const { client, closed } = openClient(b.port, "/ws/acme/repo/wf/echo", {
				Authorization: "Bearer xyz",
				"X-Auth-Provider": "local",
			});
			await new Promise<void>((resolve) =>
				client.once("open", () => resolve()),
			);
			// reconfigure with a fresh entry under the same name
			const entry2 = makeEntry(makeWsDescriptor());
			await source.reconfigure("acme", "repo", [entry2]);
			expect(client.readyState).toBe(WsClient.OPEN);
			client.close();
			const r = await closed;
			// Normal close from the client (1005 = no status) or 1000.
			expect([1000, 1005]).toContain(r.code);
		} finally {
			await source.stop();
			await b.close();
		}
	});

	it("stop() closes all connections", async () => {
		const source = createWsTriggerSource({
			logger: silentLogger(),
			authRegistry: makeAuthRegistry({
				resolves: makeUser("alice", ["acme"]),
			}),
		});
		const entry = makeEntry(makeWsDescriptor());
		await source.reconfigure("acme", "repo", [entry]);
		const b = await bind(source);
		try {
			const { client, closed } = openClient(b.port, "/ws/acme/repo/wf/echo", {
				Authorization: "Bearer xyz",
				"X-Auth-Provider": "local",
			});
			await new Promise<void>((resolve) =>
				client.once("open", () => resolve()),
			);
			await source.stop();
			const r = await closed;
			expect(r.code).toBe(1001);
		} finally {
			await b.close();
		}
	});
});
