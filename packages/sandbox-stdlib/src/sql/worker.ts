import type {
	GuestFunctionDescription,
	PluginSetup,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";
import postgres from "postgres";
import { assertHostIsPublic } from "../net-guard/index.js";
import { SQL_DISPATCHER_NAME } from "./descriptor-name.js";
import type {
	SqlColumnMetaWire,
	SqlConnectionObjectWire,
	SqlConnectionWire,
	SqlInputWire,
	SqlOptionsWire,
	SqlParam,
	SqlResultWire,
	SqlRowWire,
	SqlSslWire,
	SqlValue,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_SECONDS = 10;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function assertNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`executeSql: ${path} must be a non-empty string`);
	}
	return value;
}

function assertParam(value: unknown, index: number): SqlParam {
	if (value === null) {
		return null;
	}
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") {
		return value as SqlParam;
	}
	throw new Error(
		`executeSql: params[${index}] must be string | number | boolean | null (got ${t === "object" ? Object.prototype.toString.call(value) : t})`,
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the function is an exhaustive field-by-field validator — each `if` is a single optional-field branch with a type + error-message pair; collapsing them into a helper would hide the field/type/error mapping that's the point of the validator
function assertSslConfig(raw: unknown): boolean | SqlSslWire {
	if (typeof raw === "boolean") {
		return raw;
	}
	if (raw === null || typeof raw !== "object") {
		throw new Error(
			"executeSql: connection.ssl must be a boolean or an object",
		);
	}
	const o = raw as Record<string, unknown>;
	const out: {
		ca?: string;
		cert?: string;
		key?: string;
		rejectUnauthorized?: boolean;
		servername?: string;
	} = {};
	if (o.ca !== undefined) {
		if (typeof o.ca !== "string") {
			throw new Error("executeSql: connection.ssl.ca must be a string");
		}
		out.ca = o.ca;
	}
	if (o.cert !== undefined) {
		if (typeof o.cert !== "string") {
			throw new Error("executeSql: connection.ssl.cert must be a string");
		}
		out.cert = o.cert;
	}
	if (o.key !== undefined) {
		if (typeof o.key !== "string") {
			throw new Error("executeSql: connection.ssl.key must be a string");
		}
		out.key = o.key;
	}
	if (o.rejectUnauthorized !== undefined) {
		if (typeof o.rejectUnauthorized !== "boolean") {
			throw new Error(
				"executeSql: connection.ssl.rejectUnauthorized must be a boolean",
			);
		}
		out.rejectUnauthorized = o.rejectUnauthorized;
	}
	if (o.servername !== undefined) {
		if (typeof o.servername !== "string") {
			throw new Error("executeSql: connection.ssl.servername must be a string");
		}
		out.servername = o.servername;
	}
	return out;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: same shape as assertSslConfig — one branch per optional field; each branch is a single-type check plus error message
function assertConnectionObject(
	raw: Record<string, unknown>,
): SqlConnectionObjectWire {
	const out: {
		connectionString?: string;
		host?: string;
		port?: number;
		user?: string;
		password?: string;
		database?: string;
		ssl?: boolean | SqlSslWire;
	} = {};
	if (raw.connectionString !== undefined) {
		if (typeof raw.connectionString !== "string") {
			throw new Error(
				"executeSql: connection.connectionString must be a string",
			);
		}
		out.connectionString = raw.connectionString;
	}
	if (raw.host !== undefined) {
		if (typeof raw.host !== "string") {
			throw new Error("executeSql: connection.host must be a string");
		}
		out.host = raw.host;
	}
	if (raw.port !== undefined) {
		if (
			typeof raw.port !== "number" ||
			!Number.isInteger(raw.port) ||
			raw.port <= 0
		) {
			throw new Error("executeSql: connection.port must be a positive integer");
		}
		out.port = raw.port;
	}
	if (raw.user !== undefined) {
		if (typeof raw.user !== "string") {
			throw new Error("executeSql: connection.user must be a string");
		}
		out.user = raw.user;
	}
	if (raw.password !== undefined) {
		if (typeof raw.password !== "string") {
			throw new Error("executeSql: connection.password must be a string");
		}
		out.password = raw.password;
	}
	if (raw.database !== undefined) {
		if (typeof raw.database !== "string") {
			throw new Error("executeSql: connection.database must be a string");
		}
		out.database = raw.database;
	}
	if (raw.ssl !== undefined) {
		out.ssl = assertSslConfig(raw.ssl);
	}
	return out;
}

function assertConnection(raw: unknown): SqlConnectionWire {
	if (typeof raw === "string") {
		if (raw.length === 0) {
			throw new Error("executeSql: connection string must be non-empty");
		}
		return raw;
	}
	if (raw === null || typeof raw !== "object") {
		throw new Error("executeSql: connection must be a string or object");
	}
	return assertConnectionObject(raw as Record<string, unknown>);
}

function assertOptions(raw: unknown): SqlOptionsWire | undefined {
	if (raw === undefined) {
		return;
	}
	if (raw === null || typeof raw !== "object") {
		throw new Error("executeSql: options must be an object if provided");
	}
	const o = raw as Record<string, unknown>;
	const out: { timeoutMs?: number } = {};
	if (o.timeoutMs !== undefined) {
		if (
			typeof o.timeoutMs !== "number" ||
			!Number.isInteger(o.timeoutMs) ||
			o.timeoutMs <= 0
		) {
			throw new Error(
				"executeSql: options.timeoutMs must be a positive integer",
			);
		}
		out.timeoutMs = o.timeoutMs;
	}
	return out;
}

function assertInput(raw: unknown): SqlInputWire {
	if (raw === null || typeof raw !== "object") {
		throw new Error("executeSql: input must be an object");
	}
	const o = raw as Record<string, unknown>;
	const connection = assertConnection(o.connection);
	const query = assertNonEmptyString(o.query, "query");
	if (o.params !== undefined && !Array.isArray(o.params)) {
		throw new Error("executeSql: params must be an array if provided");
	}
	const rawParams = (o.params ?? []) as readonly unknown[];
	const params: SqlParam[] = rawParams.map((p, i) => assertParam(p, i));
	const options = assertOptions(o.options);
	const input: {
		connection: SqlConnectionWire;
		query: string;
		params: readonly SqlParam[];
		options?: SqlOptionsWire;
	} = { connection, query, params };
	if (options !== undefined) {
		input.options = options;
	}
	return input;
}

// ---------------------------------------------------------------------------
// Connection inspection
// ---------------------------------------------------------------------------

function extractHostnameFromDsn(dsn: string): string {
	let url: URL;
	try {
		url = new URL(dsn);
	} catch {
		throw new Error(
			"executeSql: connection string is not a valid URL (expected postgres://...)",
		);
	}
	if (!url.hostname) {
		throw new Error("executeSql: connection string has no host");
	}
	return url.hostname;
}

interface ConnectionFacts {
	readonly hostname: string;
	readonly database: string;
}

// URL pathnames for DSNs always have a leading "/" when a database is present;
// strip it to produce the bare database name.
const LEADING_SLASH_RE = /^\//;

function extractConnectionFacts(conn: SqlConnectionWire): ConnectionFacts {
	if (typeof conn === "string") {
		const url = new URL(conn);
		const hostname = url.hostname;
		const database = url.pathname.replace(LEADING_SLASH_RE, "") || "";
		if (!hostname) {
			throw new Error("executeSql: connection string has no host");
		}
		return { hostname, database };
	}
	let hostname: string | undefined = conn.host;
	let database: string | undefined = conn.database;
	if (!hostname && conn.connectionString) {
		const url = new URL(conn.connectionString);
		hostname = url.hostname;
		if (!database) {
			database = url.pathname.replace(LEADING_SLASH_RE, "") || undefined;
		}
	}
	if (!hostname) {
		hostname = extractHostnameFromDsn(conn.connectionString ?? "postgres://");
	}
	return { hostname, database: database ?? "" };
}

// ---------------------------------------------------------------------------
// Option building for postgres()
// ---------------------------------------------------------------------------

function clampTimeout(requested: number | undefined): number {
	const v = requested ?? DEFAULT_TIMEOUT_MS;
	if (v > MAX_TIMEOUT_MS) {
		return MAX_TIMEOUT_MS;
	}
	return v;
}

function buildSsl(
	authorSsl: boolean | SqlSslWire | undefined,
	originalHost: string,
): boolean | Record<string, unknown> | undefined {
	if (authorSsl === undefined) {
		return;
	}
	if (authorSsl === false) {
		return false;
	}
	if (authorSsl === true) {
		return { servername: originalHost };
	}
	// Object form — pass PEM fields through, pin servername.
	const out: Record<string, unknown> = { ...authorSsl };
	out.servername = originalHost;
	return out;
}

// Detect whether a `connectionString` DSN requests TLS via the standard
// libpq-style `sslmode` / `ssl` query param. When it does and the author
// hasn't supplied an explicit `ssl` object, we must still synthesize one
// with `servername` pinned — otherwise the TOCTOU-closing socket hook
// bypasses porsager's default `socket.host`-reading SNI path and the TLS
// handshake ends up without any servername at all, breaking hostname-signed
// certs (RNAcentral, AWS RDS, Neon, Supabase, …).
const DSN_TLS_MODES_REQUIRING_SSL = new Set([
	"require",
	"verify-ca",
	"verify-full",
	"prefer",
	"allow",
]);

function dsnRequestsTls(connectionString: string | undefined): boolean {
	if (!connectionString) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(connectionString);
	} catch {
		return false;
	}
	const sslmode =
		url.searchParams.get("sslmode") ?? url.searchParams.get("ssl");
	if (!sslmode) {
		return false;
	}
	const normalized = sslmode.toLowerCase();
	return DSN_TLS_MODES_REQUIRING_SSL.has(normalized);
}

// ---------------------------------------------------------------------------
// Row / value coercion (Postgres → JSON-safe)
// ---------------------------------------------------------------------------

function coerceValue(v: unknown): SqlValue {
	if (v === null || v === undefined) {
		return null;
	}
	if (typeof v === "string") {
		return v;
	}
	if (typeof v === "boolean") {
		return v;
	}
	if (typeof v === "number") {
		return Number.isFinite(v) ? v : String(v);
	}
	if (typeof v === "bigint") {
		return v.toString(10);
	}
	if (v instanceof Date) {
		return v.toISOString();
	}
	if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
		return Buffer.from(v as Buffer | Uint8Array).toString("base64");
	}
	if (Array.isArray(v)) {
		return v.map((e) => coerceValue(e));
	}
	if (typeof v === "object") {
		const out: Record<string, SqlValue> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			out[k] = coerceValue(val);
		}
		return out;
	}
	// Unknown driver-shape value: fall through to its string form.
	return String(v);
}

function coerceRow(r: Record<string, unknown>): SqlRowWire {
	const out: Record<string, SqlValue> = {};
	for (const [k, v] of Object.entries(r)) {
		out[k] = coerceValue(v);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

function shapeDriverError(err: unknown): { message: string; code?: string } {
	const e = (err ?? {}) as {
		message?: unknown;
		code?: unknown;
	};
	const message =
		typeof e.message === "string" && e.message.length > 0
			? e.message
			: "sql query failed";
	const out: { message: string; code?: string } = { message };
	if (typeof e.code === "string" && e.code.length > 0) {
		out.code = e.code;
	}
	return out;
}

function throwStructured(err: unknown): never {
	const shaped = shapeDriverError(err);
	const thrown = new Error(shaped.message);
	Object.assign(thrown, shaped);
	(thrown as { name: string }).name = "SqlError";
	throw thrown;
}

// ---------------------------------------------------------------------------
// Open-handle tracking for onRunFinished backstop
// ---------------------------------------------------------------------------

type SqlHandle = ReturnType<typeof postgres>;
const openHandles = new Set<SqlHandle>();

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: porsager/postgres's Options typing is narrow on `connection` startup params and doesn't surface the `statement_timeout` key we need to set; keeping the map `any`-valued avoids per-field assertion noise and matches how the mail worker spreads into nodemailer's open-typed transport options
type PgOptions = Record<string, any>;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the handler is a sequential recipe — extract → validate → build driver options → connect → query → coerce — splitting into helpers per step obscures the ordering that's the security contract (net-guard BEFORE socket creation, ssl servername BEFORE postgres() call)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: see preceding comment — length reflects the number of optional connection-config fields the driver accepts, not compounded logic
async function dispatchSqlExecute(input: SqlInputWire): Promise<SqlResultWire> {
	const { hostname, database: _database } = extractConnectionFacts(
		input.connection,
	);
	// Net-guard: resolve + validate the host BEFORE any socket is opened.
	const validatedIp = await assertHostIsPublic(hostname);

	const timeoutMs = clampTimeout(input.options?.timeoutMs);
	const authorSsl =
		typeof input.connection === "string" ? undefined : input.connection.ssl;
	let ssl = buildSsl(authorSsl, hostname);
	// Upgrade: when the DSN asks for TLS (sslmode=require/verify-*/prefer/allow)
	// but the author didn't pass an `ssl` object, synthesize one with the
	// servername pinned. Our socket factory bypasses the driver's default
	// `socket.connect(host, port)` code path, which is also where the driver
	// would otherwise stamp `socket.host` — the fallback SNI source — so TLS
	// without this synthesized object ends up with no servername at all.
	const connString =
		typeof input.connection === "string"
			? input.connection
			: input.connection.connectionString;
	if (ssl === undefined && dsnRequestsTls(connString)) {
		ssl = { servername: hostname, rejectUnauthorized: false };
	}

	// Build options the same way for both the string and object connection
	// forms — the driver merges `connectionString` with discrete fields itself,
	// we never do that merging ourselves. Two R-S4-mandated overrides on top of
	// whatever the driver computes: `host` is replaced with the validated IP
	// (so the driver's `socket.connect(port, host)` calls the IP we pre-resolved,
	// not whatever DNS returns at TLS-handshake time), and `ssl.servername` is
	// pinned to the original hostname so TLS SNI + cert verification still bind
	// to the name the author specified. This is the same pattern the mail plugin
	// uses for nodemailer (`host: <validatedIP>` + `tls.servername: <hostname>`).
	const options: PgOptions = {
		max: 1,
		prepare: false,
		host: validatedIp,
		// biome-ignore lint/style/useNamingConvention: porsager/postgres option keys are snake_case verbatim; renaming would break the driver contract
		connect_timeout: CONNECT_TIMEOUT_SECONDS,
		// biome-ignore lint/style/useNamingConvention: `statement_timeout` is a Postgres startup-param name passed through the wire protocol unchanged — it is not a JS identifier we are free to rename
		connection: { statement_timeout: String(timeoutMs) },
	};
	if (ssl !== undefined) {
		options.ssl = ssl;
	}
	if (typeof input.connection === "object") {
		// NOTE: we deliberately skip `host` here — the R-S4 substitution above
		// set `options.host = validatedIp`, and porsager's precedence (options
		// > connectionString-parsed) is what propagates that to the socket
		// connect. Author-supplied `host` becomes `hostname` for validation +
		// `ssl.servername` pinning; the driver must NOT connect to the raw
		// hostname.
		if (input.connection.port !== undefined) {
			options.port = input.connection.port;
		}
		if (input.connection.user !== undefined) {
			options.user = input.connection.user;
		}
		if (input.connection.password !== undefined) {
			options.password = input.connection.password;
		}
		if (input.connection.database !== undefined) {
			options.database = input.connection.database;
		}
	}

	const url: string =
		typeof input.connection === "string"
			? input.connection
			: (input.connection.connectionString ?? "");

	// postgres(url, options) accepts url as string or URL; empty string + object
	// form is the "fully-discrete" shape porsager supports.
	const sql = url
		? postgres(url, options)
		: postgres(options as unknown as string);
	openHandles.add(sql);

	try {
		// porsager/postgres: when params is empty the driver uses Postgres's
		// simple-query protocol (multi-statement allowed, no parameter
		// binding); when params is non-empty it uses the extended protocol
		// (parameters bound, single statement). We rely on that default rather
		// than forcing one mode, because the two protocols' constraints are
		// mutually exclusive and the author's choice of `params` already
		// disambiguates which they want.
		const raw = (await sql.unsafe(
			input.query,
			input.params as never[],
		)) as unknown;
		const driverRows = Array.isArray(raw)
			? (raw as Record<string, unknown>[])
			: [];
		const rows = driverRows.map((r) => coerceRow(r));
		const columnsRaw =
			(raw as { columns?: { name: string; type: number }[] }).columns ?? [];
		const columns: SqlColumnMetaWire[] = columnsRaw.map((c) => ({
			name: String(c.name),
			// biome-ignore lint/style/useNamingConvention: `dataTypeID` matches pg / porsager / DefinitelyTyped's ColumnMeta field verbatim; wire contract is driver-derived
			dataTypeID: Number(c.type),
		}));
		const reportedCount =
			(raw as { count?: number }).count ?? driverRows.length;
		return {
			rows,
			columns,
			rowCount: reportedCount,
		};
	} catch (err) {
		throwStructured(err);
	} finally {
		openHandles.delete(sql);
		// Safe to race with the onRunFinished backstop — porsager's end() merges
		// concurrent calls via `if (ending) return ending`
		// (postgres@3.4.9 src/index.js:366).
		await sql.end({ timeout: 5 }).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// Descriptor + plugin setup
// ---------------------------------------------------------------------------

function sqlDispatcherDescriptor(): GuestFunctionDescription {
	return {
		name: SQL_DISPATCHER_NAME,
		args: [Guest.raw()],
		result: Guest.raw(),
		handler: (async (raw: unknown) => {
			const input = assertInput(raw);
			const result = await dispatchSqlExecute(input);
			return result as unknown as Record<string, unknown>;
		}) as unknown as GuestFunctionDescription["handler"],
		log: { request: "system" },
		logName: (args) => {
			const input = args[0] as Partial<SqlInputWire> | undefined;
			if (!input || typeof input !== "object") {
				return "executeSql";
			}
			try {
				const facts = extractConnectionFacts(
					input.connection as SqlConnectionWire,
				);
				return `executeSql ${facts.hostname}/${facts.database}`;
			} catch {
				return "executeSql";
			}
		},
		logInput: (args) => {
			const input = args[0] as Partial<SqlInputWire> | undefined;
			if (!input || typeof input !== "object") {
				return args;
			}
			const picked: Record<string, unknown> = { engine: "postgres" };
			try {
				const facts = extractConnectionFacts(
					input.connection as SqlConnectionWire,
				);
				picked.host = facts.hostname;
				picked.database = facts.database;
			} catch {
				picked.host = "";
				picked.database = "";
			}
			picked.query = typeof input.query === "string" ? input.query : "";
			picked.paramCount = Array.isArray(input.params) ? input.params.length : 0;
			return picked;
		},
		public: false,
	};
}

function worker(_ctx: SandboxContext): PluginSetup {
	return {
		guestFunctions: [sqlDispatcherDescriptor()],
		onRunFinished: async () => {
			const handles = Array.from(openHandles);
			openHandles.clear();
			// porsager/postgres end() is idempotent: `if (ending) return ending`
			// (postgres@3.4.9 src/index.js:366). Safe to race with the per-query
			// `finally { sql.end() }` — both callers share one teardown.
			await Promise.allSettled(
				handles.map((h) => h.end({ timeout: 0 }).catch(() => undefined)),
			);
		},
	};
}

export {
	assertInput,
	buildSsl,
	clampTimeout,
	coerceRow,
	coerceValue,
	dispatchSqlExecute,
	extractConnectionFacts,
	shapeDriverError,
	worker,
};
