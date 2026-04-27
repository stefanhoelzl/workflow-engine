import type { SandboxContext } from "@workflow-engine/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock DNS so we can drive public / private / reserved addresses per test.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(),
}));

// Mock the postgres driver. `postgres(url, options)` returns a tagged-template
// function with `.unsafe(query, params)` and `.end({timeout})` methods; we
// capture what the plugin passes and let tests override the per-call outcome.
const pgMock = vi.hoisted(() => {
	const state = {
		lastArgs: null as { url: string | undefined; options: unknown } | null,
		unsafe: vi.fn() as ReturnType<typeof vi.fn>,
		end: vi.fn() as ReturnType<typeof vi.fn>,
		factory: vi.fn() as ReturnType<typeof vi.fn>,
	};
	state.end = vi.fn(async () => undefined);
	state.factory = vi.fn((...args: unknown[]) => {
		const url = typeof args[0] === "string" ? args[0] : undefined;
		const options = typeof args[0] === "string" ? args[1] : args[0];
		state.lastArgs = { url, options };
		const sqlFn = Object.assign(
			((..._inner: unknown[]) => undefined) as unknown as {
				unsafe: typeof state.unsafe;
				end: typeof state.end;
			},
			{ unsafe: state.unsafe, end: state.end },
		);
		return sqlFn;
	});
	return state;
});
vi.mock("postgres", () => ({
	default: pgMock.factory,
}));

import { lookup as mockLookup } from "node:dns/promises";
import { SQL_DISPATCHER_NAME } from "./descriptor-name.js";
import {
	assertInput,
	buildSsl,
	clampTimeout,
	coerceRow,
	coerceValue,
	dispatchSqlExecute,
	extractConnectionFacts,
	shapeDriverError,
	worker,
} from "./worker.js";

const lookup = vi.mocked(mockLookup) as unknown as {
	mockResolvedValueOnce: (
		value: Array<{ address: string; family: 4 | 6 }>,
	) => void;
	mockReset: () => void;
};

const PUBLIC_IP = "93.184.216.34";

function mockPublicHost(addr = PUBLIC_IP): void {
	lookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
}

function mockPrivateHost(addr = "10.0.0.5"): void {
	lookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
}

function mockDriverRows(
	rows: Record<string, unknown>[],
	columns: { name: string; type: number }[] = [],
	count?: number,
): void {
	const out = Object.assign(rows, {
		columns,
		count: count ?? rows.length,
	});
	pgMock.unsafe.mockImplementationOnce(async () => out);
}

function mockDriverError(err: unknown): void {
	pgMock.unsafe.mockImplementationOnce(async () => {
		throw err;
	});
}

function captureOptions(): Record<string, unknown> {
	const last = pgMock.lastArgs;
	if (!last) {
		throw new Error("postgres() was not called");
	}
	return last.options as Record<string, unknown>;
}

function noopCtx(): SandboxContext {
	return {
		emit() {
			/* no-op */
		},
		request(_p: unknown, _n: unknown, _e: unknown, fn: () => unknown) {
			return fn();
		},
	} as unknown as SandboxContext;
}

beforeEach(() => {
	lookup.mockReset();
	pgMock.unsafe.mockReset();
	pgMock.end.mockReset();
	pgMock.end.mockImplementation(async () => undefined);
	pgMock.factory.mockClear();
	pgMock.lastArgs = null;
});

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

describe("sql plugin — descriptor shape", () => {
	it("exposes name + dispatcher descriptor with log.request:'system'", () => {
		const setup = worker(noopCtx());
		expect(setup.guestFunctions).toHaveLength(1);
		const gf = setup.guestFunctions?.[0];
		expect(gf?.name).toBe(SQL_DISPATCHER_NAME);
		expect(gf?.public).toBe(false);
		expect(gf?.log).toEqual({ request: "system" });
	});

	it("logName uses executeSql + host/database", () => {
		const gf = worker(noopCtx()).guestFunctions?.[0];
		const name = gf?.logName?.([
			{
				connection: "postgres://u:p@db.example.com:5432/mydb",
				query: "SELECT 1",
				params: [],
			} as unknown,
		]);
		expect(name).toBe("executeSql db.example.com/mydb");
	});

	it("logInput emits engine/host/database/query/paramCount and drops param values", () => {
		const gf = worker(noopCtx()).guestFunctions?.[0];
		const picked = gf?.logInput?.([
			{
				connection: "postgres://u:p@db.example.com:5432/mydb",
				query: "SELECT * FROM t WHERE id = $1",
				params: ["secret-token"],
			} as unknown,
		]);
		expect(picked).toEqual({
			engine: "postgres",
			host: "db.example.com",
			database: "mydb",
			query: "SELECT * FROM t WHERE id = $1",
			paramCount: 1,
		});
		expect(JSON.stringify(picked)).not.toContain("secret-token");
	});
});

// ---------------------------------------------------------------------------
// Security / hardening
// ---------------------------------------------------------------------------

describe("sql plugin — security hardening", () => {
	it("rejects RFC-1918 host before postgres() is called", async () => {
		mockPrivateHost("10.0.0.5");
		await expect(
			dispatchSqlExecute({
				connection: "postgres://db.internal/app",
				query: "SELECT 1",
				params: [],
			}),
		).rejects.toThrow();
		expect(pgMock.factory).not.toHaveBeenCalled();
	});

	it("rejects IANA-reserved host (169.254.169.254) before postgres() is called", async () => {
		mockPrivateHost("169.254.169.254");
		await expect(
			dispatchSqlExecute({
				connection: "postgres://169.254.169.254/app",
				query: "SELECT 1",
				params: [],
			}),
		).rejects.toThrow();
		expect(pgMock.factory).not.toHaveBeenCalled();
	});

	it("overrides options.host with the validated IP (closing the DNS-rebinding TOCTOU)", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com:5432/app",
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		expect(options.host).toBe(PUBLIC_IP);
		// Negative: the raw hostname must NOT appear in options.host
		expect(options.host).not.toBe("db.example.com");
	});

	it("upgrades DSN with sslmode=require to an ssl object with servername pinned", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app?sslmode=require",
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		// When author requests TLS via DSN but supplies no explicit ssl object,
		// the plugin synthesizes one so TLS SNI still points at the hostname
		// (not the validated IP the driver connects to).
		expect(options.ssl).toEqual({
			servername: "db.example.com",
			rejectUnauthorized: false,
		});
	});

	it("pins ssl.servername to the original hostname when ssl: true", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: {
				connectionString: "postgres://db.example.com:5432/app",
				ssl: true,
			},
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		expect(options.ssl).toEqual({ servername: "db.example.com" });
	});

	it("passes author ssl.ca/cert/key/rejectUnauthorized through while pinning servername", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		const ca = "-----BEGIN CERTIFICATE-----\nMIIABC\n-----END CERTIFICATE-----";
		const cert = "-----BEGIN CERTIFICATE-----\nDEF\n-----END CERTIFICATE-----";
		const key = "-----BEGIN PRIVATE KEY-----\nGHI\n-----END PRIVATE KEY-----";
		await dispatchSqlExecute({
			connection: {
				connectionString: "postgres://db.example.com/app",
				ssl: { ca, cert, key, rejectUnauthorized: true },
			},
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		expect(options.ssl).toEqual({
			ca,
			cert,
			key,
			rejectUnauthorized: true,
			servername: "db.example.com",
		});
	});

	it("omits ssl entirely when author does not request TLS", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		expect("ssl" in options).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Driver-call shape
// ---------------------------------------------------------------------------

describe("sql plugin — driver-call shape", () => {
	it("passes max:1, prepare:false, connect_timeout:10", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		expect(options.max).toBe(1);
		expect(options.prepare).toBe(false);
		expect(options.connect_timeout).toBe(10);
	});

	it("defaults statement_timeout to 30000 ms when options.timeoutMs is absent", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
		});
		const options = captureOptions();
		expect(options.connection).toEqual({
			statement_timeout: "30000",
		});
	});

	it("passes statement_timeout through when under the ceiling", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
			options: { timeoutMs: 5000 },
		});
		const options = captureOptions();
		expect(options.connection).toEqual({
			statement_timeout: "5000",
		});
	});

	it("clamps statement_timeout to the 120_000 ms ceiling", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
			options: { timeoutMs: 999_999 },
		});
		const options = captureOptions();
		expect(options.connection).toEqual({
			statement_timeout: "120000",
		});
	});

	it("invokes sql.unsafe with (query, params) — no third argument that would override protocol selection", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT $1::int AS n",
			params: [42],
		});
		expect(pgMock.unsafe).toHaveBeenCalledTimes(1);
		const call = pgMock.unsafe.mock.calls[0];
		expect(call?.[0]).toBe("SELECT $1::int AS n");
		expect(call?.[1]).toEqual([42]);
		// No third arg — driver picks protocol based on params length
		expect(call?.[2]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Row coercion
// ---------------------------------------------------------------------------

describe("sql plugin — row coercion (Postgres → JSON-safe)", () => {
	it("coerces Date to ISO string", () => {
		const d = new Date("2026-04-24T12:34:56.000Z");
		expect(coerceValue(d)).toBe("2026-04-24T12:34:56.000Z");
	});

	it("coerces Buffer to base64", () => {
		expect(coerceValue(Buffer.from("hello"))).toBe("aGVsbG8=");
	});

	it("coerces Uint8Array to base64", () => {
		const bytes = new Uint8Array([0x48, 0x69]);
		expect(coerceValue(bytes)).toBe("SGk=");
	});

	it("coerces bigint to decimal string", () => {
		expect(coerceValue(9_007_199_254_740_993n)).toBe("9007199254740993");
	});

	it("passes strings, numbers, booleans, null through", () => {
		expect(coerceValue("hi")).toBe("hi");
		expect(coerceValue(42)).toBe(42);
		expect(coerceValue(true)).toBe(true);
		expect(coerceValue(null)).toBe(null);
		expect(coerceValue(undefined)).toBe(null);
	});

	it("coerces nested arrays recursively", () => {
		const d = new Date("2026-04-24T00:00:00.000Z");
		expect(coerceValue([1, d, [Buffer.from("ab")]])).toEqual([
			1,
			"2026-04-24T00:00:00.000Z",
			["YWI="],
		]);
	});

	it("coerces jsonb-style objects recursively", () => {
		expect(
			coerceValue({
				nested: { at: new Date("2026-04-24T00:00:00.000Z") },
			}),
		).toEqual({ nested: { at: "2026-04-24T00:00:00.000Z" } });
	});

	it("coerces a row via coerceRow", () => {
		const row = {
			id: 1,
			created_at: new Date("2026-04-24T00:00:00.000Z"),
			payload: Buffer.from("x"),
		};
		expect(coerceRow(row)).toEqual({
			id: 1,
			created_at: "2026-04-24T00:00:00.000Z",
			payload: "eA==",
		});
	});

	it("converts driver output to a JSON-safe SqlResult", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows(
			[
				{
					id: 1n,
					at: new Date("2026-04-24T00:00:00.000Z"),
					b: Buffer.from("hi"),
				},
			],
			[
				{ name: "id", type: 20 },
				{ name: "at", type: 1184 },
				{ name: "b", type: 17 },
			],
			1,
		);
		const r = await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT *",
			params: [],
		});
		expect(r.rows).toEqual([
			{ id: "1", at: "2026-04-24T00:00:00.000Z", b: "aGk=" },
		]);
		expect(r.columns).toEqual([
			{ name: "id", dataTypeID: 20 },
			{ name: "at", dataTypeID: 1184 },
			{ name: "b", dataTypeID: 17 },
		]);
		expect(r.rowCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Input validation (Zod-equivalent)
// ---------------------------------------------------------------------------

describe("sql plugin — input validation", () => {
	it("rejects Date as a param value at the boundary", () => {
		expect(() =>
			assertInput({
				connection: "postgres://h/db",
				query: "SELECT $1",
				params: [new Date()],
			}),
		).toThrow(/params\[0\] must be string \| number \| boolean \| null/);
	});

	it("rejects Uint8Array as a param value at the boundary", () => {
		expect(() =>
			assertInput({
				connection: "postgres://h/db",
				query: "SELECT $1",
				params: [new Uint8Array([1, 2])],
			}),
		).toThrow(/params\[0\]/);
	});

	it("rejects BigInt as a param value at the boundary", () => {
		expect(() =>
			assertInput({
				connection: "postgres://h/db",
				query: "SELECT $1",
				params: [42n as unknown as number],
			}),
		).toThrow(/params\[0\]/);
	});

	it("rejects an empty query string", () => {
		expect(() =>
			assertInput({
				connection: "postgres://h/db",
				query: "",
				params: [],
			}),
		).toThrow(/query must be a non-empty string/);
	});

	it("rejects non-positive timeoutMs", () => {
		expect(() =>
			assertInput({
				connection: "postgres://h/db",
				query: "SELECT 1",
				params: [],
				options: { timeoutMs: 0 },
			}),
		).toThrow(/timeoutMs/);
		expect(() =>
			assertInput({
				connection: "postgres://h/db",
				query: "SELECT 1",
				params: [],
				options: { timeoutMs: -1 },
			}),
		).toThrow(/timeoutMs/);
	});

	it("accepts all JSON scalars as params", () => {
		const ok = assertInput({
			connection: "postgres://h/db",
			query: "SELECT 1",
			params: ["s", 1, true, null],
		});
		expect(ok.params).toEqual(["s", 1, true, null]);
	});
});

// ---------------------------------------------------------------------------
// Connection facts
// ---------------------------------------------------------------------------

describe("sql plugin — connection facts", () => {
	it("extracts hostname and database from a DSN string", () => {
		const f = extractConnectionFacts("postgres://u:p@db.example.com:5432/mydb");
		expect(f).toEqual({ hostname: "db.example.com", database: "mydb" });
	});

	it("extracts from a ConnectionObject with discrete fields", () => {
		const f = extractConnectionFacts({
			host: "db.example.com",
			database: "mydb",
		});
		expect(f).toEqual({ hostname: "db.example.com", database: "mydb" });
	});

	it("extracts from a ConnectionObject with connectionString + no discrete override", () => {
		const f = extractConnectionFacts({
			connectionString: "postgres://u:p@db.example.com:5432/mydb",
		});
		expect(f).toEqual({ hostname: "db.example.com", database: "mydb" });
	});
});

// ---------------------------------------------------------------------------
// buildSsl / clampTimeout primitives
// ---------------------------------------------------------------------------

describe("sql plugin — primitives", () => {
	it("clampTimeout defaults and ceiling", () => {
		expect(clampTimeout(undefined)).toBe(30_000);
		expect(clampTimeout(5000)).toBe(5000);
		expect(clampTimeout(999_999)).toBe(120_000);
	});

	it("buildSsl(undefined) returns undefined", () => {
		expect(buildSsl(undefined, "h")).toBeUndefined();
	});

	it("buildSsl(false) returns false", () => {
		expect(buildSsl(false, "h")).toBe(false);
	});

	it("buildSsl(true, host) pins servername", () => {
		expect(buildSsl(true, "db.example.com")).toEqual({
			servername: "db.example.com",
		});
	});

	it("buildSsl(object, host) preserves PEMs and pins servername", () => {
		const result = buildSsl(
			{ ca: "CA-PEM", rejectUnauthorized: true },
			"db.example.com",
		);
		expect(result).toEqual({
			ca: "CA-PEM",
			rejectUnauthorized: true,
			servername: "db.example.com",
		});
	});
});

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

describe("sql plugin — error shaping", () => {
	it("preserves Postgres SQLSTATE as code (57014 statement_timeout)", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverError(
			Object.assign(new Error("canceling statement due to statement timeout"), {
				code: "57014",
			}),
		);
		await expect(
			dispatchSqlExecute({
				connection: "postgres://db.example.com/app",
				query: "SELECT pg_sleep(10)",
				params: [],
			}),
		).rejects.toMatchObject({
			message: "canceling statement due to statement timeout",
			code: "57014",
		});
	});

	it("preserves SQLSTATE for auth failure (28P01)", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverError(
			Object.assign(new Error("password authentication failed"), {
				code: "28P01",
			}),
		);
		await expect(
			dispatchSqlExecute({
				connection: "postgres://db.example.com/app",
				query: "SELECT 1",
				params: [],
			}),
		).rejects.toMatchObject({
			message: "password authentication failed",
			code: "28P01",
		});
	});

	it("preserves SQLSTATE for syntax error (42601)", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverError(
			Object.assign(new Error('syntax error at or near "SELCT"'), {
				code: "42601",
			}),
		);
		await expect(
			dispatchSqlExecute({
				connection: "postgres://db.example.com/app",
				query: "SELCT 1",
				params: [],
			}),
		).rejects.toMatchObject({
			message: 'syntax error at or near "SELCT"',
			code: "42601",
		});
	});

	it("omits code when driver error has none (pre-handshake failure)", () => {
		const shaped = shapeDriverError(new Error("connect ECONNREFUSED"));
		expect(shaped).toEqual({ message: "connect ECONNREFUSED" });
		expect("code" in shaped).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("sql plugin — cleanup", () => {
	it("awaits sql.end({timeout:0}) on success", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
		});
		expect(pgMock.end).toHaveBeenCalledWith({ timeout: 0 });
	});

	it("awaits sql.end({timeout:0}) on error", async () => {
		mockPublicHost(PUBLIC_IP);
		mockDriverError(new Error("boom"));
		await expect(
			dispatchSqlExecute({
				connection: "postgres://db.example.com/app",
				query: "SELECT 1",
				params: [],
			}),
		).rejects.toThrow(/boom/);
		expect(pgMock.end).toHaveBeenCalledWith({ timeout: 0 });
	});

	it("onRunFinished resolves cleanly when per-call release already drained the set", async () => {
		// After a successful per-call release, the handle is removed from the
		// helper's tracking Set. The backstop's drain must find nothing to
		// close and must resolve without throwing.
		mockPublicHost(PUBLIC_IP);
		mockDriverRows([]);
		await dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
		});
		const setup = worker(noopCtx());
		await expect(
			setup.onRunFinished?.({ ok: true, output: undefined }, {
				event: undefined,
			} as never),
		).resolves.toBeUndefined();
	});

	it("fire-and-forgot handle is closed by onRunFinished", async () => {
		mockPublicHost(PUBLIC_IP);
		// Simulate a query that never resolves — the dispatcher's `await`
		// parks, so the per-call `finally` does not run during the run window.
		pgMock.unsafe.mockImplementationOnce(() => new Promise(() => {}));

		// Kick off dispatch but do NOT await it. The catch silences the
		// pending rejection so the test runner doesn't flag it as unhandled.
		dispatchSqlExecute({
			connection: "postgres://db.example.com/app",
			query: "SELECT 1",
			params: [],
		}).catch(() => undefined);
		await Promise.resolve();
		await Promise.resolve();

		// Run end: drain via the worker's onRunFinished.
		const setup = worker(noopCtx());
		await setup.onRunFinished?.({ ok: true, output: undefined }, {
			event: undefined,
		} as never);
		expect(pgMock.end).toHaveBeenCalledWith({ timeout: 0 });
	});
});
