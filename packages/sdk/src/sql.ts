// `executeSql` is a thin guest-side wrapper over the locked `__sql.execute`
// dispatcher installed by the sandbox-stdlib SQL plugin. The only thing this
// wrapper does is validate that `params` is a JSON-safe scalar array before
// bridging — the plugin's worker re-validates, but catching the bad type at
// the SDK boundary produces a clearer stack trace for the author.
//
// Implementation note: this wrapper calls `sql.unsafe(query, params, {simple: true})`
// on the host side. That method name is porsager/postgres's label for the
// raw-string API; when called with `$N` placeholders and a params array it is
// parameterized and injection-safe. We don't expose tagged-template authoring
// because our threat model treats the workflow author as the owner of both the
// query text and the target database — injection is an author footgun, not a
// sandbox escalation vector.

type SqlParam = string | number | boolean | null;

type SqlValue =
	| string
	| number
	| boolean
	| null
	| readonly SqlValue[]
	| { readonly [k: string]: SqlValue };

interface SqlSsl {
	readonly ca?: string;
	readonly cert?: string;
	readonly key?: string;
	readonly rejectUnauthorized?: boolean;
	readonly servername?: string;
}

interface SqlConnectionObject {
	readonly connectionString?: string;
	readonly host?: string;
	readonly port?: number;
	readonly user?: string;
	readonly password?: string;
	readonly database?: string;
	readonly ssl?: boolean | SqlSsl;
}

type SqlConnection = string | SqlConnectionObject;

interface SqlOptions {
	readonly timeoutMs?: number;
}

interface SqlColumnMeta {
	readonly name: string;
	// biome-ignore lint/style/useNamingConvention: `dataTypeID` matches pg / porsager / DefinitelyTyped's ColumnMeta field verbatim; renaming would desync from driver-derived metadata
	readonly dataTypeID: number;
}

interface SqlRow {
	readonly [k: string]: SqlValue;
}

interface SqlResult {
	readonly rows: readonly SqlRow[];
	readonly columns: readonly SqlColumnMeta[];
	readonly rowCount: number;
}

interface SqlError extends Error {
	readonly code?: string;
}

interface SqlDispatcher {
	execute(input: unknown): Promise<SqlResult>;
}

function getSqlDispatcher(): SqlDispatcher {
	const api = (globalThis as Record<string, unknown>).__sql as
		| SqlDispatcher
		| undefined;
	if (!api || typeof api.execute !== "function") {
		throw new Error(
			"SQL dispatcher unavailable; executeSql can only run inside the workflow sandbox",
		);
	}
	return api;
}

function describeBadParam(value: unknown): string {
	const t = typeof value;
	if (t !== "object") {
		return t;
	}
	if (value === undefined) {
		return "undefined";
	}
	return Object.prototype.toString.call(value);
}

function assertJsonParam(value: unknown, index: number): SqlParam {
	if (value === null) {
		return null;
	}
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") {
		return value as SqlParam;
	}
	// Reject Date / Uint8Array / BigInt / objects / undefined explicitly
	// so authors get a clear error before the host boundary rejects them.
	throw new TypeError(
		`executeSql: params[${index}] must be string | number | boolean | null (got ${describeBadParam(value)})`,
	);
}

/**
 * Send a parameterized SQL query to a Postgres server and return JSON-safe
 * rows.
 *
 * `params` uses `$1`, `$2`, … placeholders. Values must be JSON scalars
 * (`string | number | boolean | null`); encode dates as ISO strings, bytes
 * as base64, and bigints as decimal strings at the call site.
 *
 * Row values returned by this function are always JSON-safe — `timestamptz`
 * comes back as an ISO string, `bytea` as a base64 string, `int8`/large
 * `numeric` as a decimal string, `jsonb` as a parsed object. Reconstruct
 * `Date` / `Uint8Array` client-side if you need them.
 *
 * There is no result-size cap: a runaway `SELECT *` against a large table
 * can exhaust the plugin worker's memory for that invocation. Use `LIMIT`
 * explicitly.
 *
 * For multi-statement queries (`"BEGIN; ...; COMMIT;"`), only the last
 * statement's result set is returned.
 */
async function executeSql(
	connection: SqlConnection,
	query: string,
	params: readonly SqlParam[] = [],
	options?: SqlOptions,
): Promise<SqlResult> {
	if (typeof query !== "string" || query.length === 0) {
		throw new TypeError("executeSql: query must be a non-empty string");
	}
	if (!Array.isArray(params)) {
		throw new TypeError("executeSql: params must be an array");
	}
	const checked: SqlParam[] = params.map((p, i) => assertJsonParam(p, i));
	const api = getSqlDispatcher();
	const input: {
		connection: SqlConnection;
		query: string;
		params: readonly SqlParam[];
		options?: SqlOptions;
	} = { connection, query, params: checked };
	if (options !== undefined) {
		input.options = options;
	}
	return await api.execute(input);
}

export type {
	SqlColumnMeta,
	SqlConnection,
	SqlConnectionObject,
	SqlError,
	SqlOptions,
	SqlParam,
	SqlResult,
	SqlRow,
	SqlSsl,
	SqlValue,
};
export { executeSql };
