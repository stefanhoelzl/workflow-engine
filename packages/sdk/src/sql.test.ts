import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSql } from "./sql.js";

interface BridgedCall {
	input: Record<string, unknown>;
}

function installMockDispatcher(result?: unknown): BridgedCall[] {
	const calls: BridgedCall[] = [];
	const execute = vi.fn(async (input: unknown) => {
		calls.push({ input: input as Record<string, unknown> });
		return result ?? { rows: [], columns: [], rowCount: 0 };
	});
	Object.defineProperty(globalThis, "__sql", {
		value: Object.freeze({ execute }),
		writable: false,
		configurable: true,
		enumerable: false,
	});
	return calls;
}

function uninstallMockDispatcher(): void {
	// biome-ignore lint/performance/noDelete: __sql is installed with writable:false; delete + configurable:true is the only way to reset it between tests
	delete (globalThis as unknown as { __sql?: unknown }).__sql;
}

beforeEach(() => {
	uninstallMockDispatcher();
});
afterEach(() => {
	uninstallMockDispatcher();
});

describe("executeSql SDK wrapper", () => {
	it("rejects Date as a param with TypeError before dispatching", async () => {
		installMockDispatcher();
		await expect(
			executeSql("postgres://h/db", "SELECT $1", [
				new Date() as unknown as string,
			]),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects Uint8Array as a param with TypeError before dispatching", async () => {
		installMockDispatcher();
		await expect(
			executeSql("postgres://h/db", "SELECT $1", [
				new Uint8Array([1, 2]) as unknown as string,
			]),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects BigInt as a param with TypeError before dispatching", async () => {
		installMockDispatcher();
		await expect(
			executeSql("postgres://h/db", "SELECT $1", [42n as unknown as number]),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects plain objects as params with TypeError", async () => {
		installMockDispatcher();
		await expect(
			executeSql("postgres://h/db", "SELECT $1", [
				{ x: 1 } as unknown as string,
			]),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects undefined as a param with TypeError", async () => {
		installMockDispatcher();
		await expect(
			executeSql("postgres://h/db", "SELECT $1", [
				undefined as unknown as string,
			]),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects empty query", async () => {
		installMockDispatcher();
		await expect(executeSql("postgres://h/db", "", [])).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	it("passes string connection through verbatim", async () => {
		const calls = installMockDispatcher();
		await executeSql("postgres://h/db", "SELECT 1", []);
		expect(calls[0]?.input).toEqual({
			connection: "postgres://h/db",
			query: "SELECT 1",
			params: [],
		});
	});

	it("passes ConnectionObject fields through verbatim", async () => {
		const calls = installMockDispatcher();
		await executeSql(
			{
				host: "h",
				port: 5432,
				user: "u",
				password: "p",
				database: "d",
				ssl: { ca: "CA-PEM", rejectUnauthorized: true },
			},
			"SELECT 1",
			[],
		);
		expect(calls[0]?.input).toEqual({
			connection: {
				host: "h",
				port: 5432,
				user: "u",
				password: "p",
				database: "d",
				ssl: { ca: "CA-PEM", rejectUnauthorized: true },
			},
			query: "SELECT 1",
			params: [],
		});
	});

	it("passes JSON-scalar params through verbatim", async () => {
		const calls = installMockDispatcher();
		await executeSql("postgres://h/db", "SELECT $1,$2,$3,$4", [
			"s",
			1,
			true,
			null,
		]);
		expect(calls[0]?.input.params).toEqual(["s", 1, true, null]);
	});

	it("passes options.timeoutMs through to the bridge", async () => {
		const calls = installMockDispatcher();
		await executeSql("postgres://h/db", "SELECT 1", [], { timeoutMs: 5000 });
		expect(calls[0]?.input.options).toEqual({ timeoutMs: 5000 });
	});

	it("returns the bridge's result unchanged", async () => {
		const expected = {
			rows: [{ id: 1, name: "x" }],
			columns: [
				{ name: "id", dataTypeID: 23 },
				{ name: "name", dataTypeID: 25 },
			],
			rowCount: 1,
		};
		installMockDispatcher(expected);
		const r = await executeSql("postgres://h/db", "SELECT 1", []);
		expect(r).toEqual(expected);
	});

	it("propagates structured error envelopes from the bridge", async () => {
		Object.defineProperty(globalThis, "__sql", {
			value: Object.freeze({
				execute: vi.fn(async () => {
					const err = new Error("canceling statement due to statement timeout");
					Object.assign(err, { code: "57014" });
					throw err;
				}),
			}),
			writable: false,
			configurable: true,
			enumerable: false,
		});
		await expect(
			executeSql("postgres://h/db", "SELECT pg_sleep(10)", []),
		).rejects.toMatchObject({
			message: "canceling statement due to statement timeout",
			code: "57014",
		});
	});

	it("throws a helpful error when the dispatcher is not installed", async () => {
		// __sql not installed
		await expect(executeSql("postgres://h/db", "SELECT 1", [])).rejects.toThrow(
			/can only run inside the workflow sandbox/,
		);
	});
});
