import { GuestSafeError } from "@workflow-engine/sandbox";

type SqlErrorKind =
	| "invalid-input"
	| "connection"
	| "timeout"
	| "auth"
	| "query-error";

interface SqlErrorOptions {
	readonly kind: SqlErrorKind;
	readonly code?: string;
	readonly severity?: string;
	readonly position?: number;
	readonly detail?: string;
	readonly hint?: string;
	readonly schemaName?: string;
	readonly tableName?: string;
	readonly columnName?: string;
	readonly constraintName?: string;
	readonly dataTypeName?: string;
	readonly message?: string;
}

/**
 * Bridge-safe SQL error. Constructed by the `$sql/do` dispatcher's input
 * validators (kind = "invalid-input") and by the `shapeDriverError`
 * post-postgres translator. The driver `.message`, `.stack`, `.cause`,
 * `.file`, `.line`, `.routine`, `.internal_query`, `.internal_position`,
 * `.where`, and `.query` fields are NOT forwarded — `.message` is built
 * from `kind`, `code`, `severity`, `detail`, `hint` per
 * `openspec/specs/sandbox-stdlib/spec.md` "SqlError shape for `$sql/do`
 * failures".
 */
class SqlError extends GuestSafeError {
	override readonly name = "SqlError";
	readonly kind: SqlErrorKind;
	readonly code?: string;
	readonly severity?: string;
	readonly position?: number;
	readonly detail?: string;
	readonly hint?: string;
	readonly schemaName?: string;
	readonly tableName?: string;
	readonly columnName?: string;
	readonly constraintName?: string;
	readonly dataTypeName?: string;

	constructor(options: SqlErrorOptions) {
		const message = options.message ?? buildMessage(options);
		super(message);
		this.kind = options.kind;
		assignIfDefined(this, options, "code");
		assignIfDefined(this, options, "severity");
		assignIfDefined(this, options, "position");
		assignIfDefined(this, options, "detail");
		assignIfDefined(this, options, "hint");
		assignIfDefined(this, options, "schemaName");
		assignIfDefined(this, options, "tableName");
		assignIfDefined(this, options, "columnName");
		assignIfDefined(this, options, "constraintName");
		assignIfDefined(this, options, "dataTypeName");
	}
}

function assignIfDefined<K extends keyof SqlErrorOptions>(
	target: SqlError,
	source: SqlErrorOptions,
	key: K,
): void {
	const value = source[key];
	if (value !== undefined) {
		(target as unknown as Record<string, unknown>)[key as string] = value;
	}
}

function buildMessage(options: SqlErrorOptions): string {
	let head: string = options.kind;
	if (options.code) {
		head = `${head} (${options.code})`;
	}
	if (options.severity && options.severity !== "ERROR") {
		head = `${head} [${options.severity}]`;
	}
	let suffix = "";
	if (options.detail) {
		suffix = `: ${options.detail}`;
	}
	if (options.hint) {
		suffix = `${suffix} (hint: ${options.hint})`;
	}
	return head + suffix;
}

const DRIVER_CODE_PREFIX = /^[A-Z]/;

/**
 * Map a postgres SQLSTATE / driver code to one of the SqlErrorKind values.
 * Translation per `openspec/specs/sandbox-stdlib/spec.md` "SqlError shape …".
 */
function classifySqlKind(
	code: string | undefined,
	severity: string | undefined,
): SqlErrorKind {
	if (code === undefined) {
		return severity === undefined ? "connection" : "query-error";
	}
	if (DRIVER_CODE_PREFIX.test(code)) {
		if (code === "CONNECT_TIMEOUT" || code === "IDLE_TIMEOUT") {
			return "timeout";
		}
		if (code.startsWith("CONNECTION_")) {
			return "connection";
		}
		return "query-error";
	}
	if (code === "57014") {
		return "timeout";
	}
	const cls = code.slice(0, 2);
	if (cls === "08") {
		return "connection";
	}
	if (cls === "28") {
		return "auth";
	}
	if (cls === "53") {
		return "connection";
	}
	return "query-error";
}

export type { SqlErrorKind, SqlErrorOptions };
export { classifySqlKind, SqlError };
