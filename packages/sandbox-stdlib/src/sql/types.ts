// Wire shapes for the `$sql/do` bridge. Shared between the worker
// implementation and tests. Types-only module so the guest pass can
// import them without pulling in the porsager/postgres driver.

type SqlParam = string | number | boolean | null;

type SqlValue =
	| string
	| number
	| boolean
	| null
	| readonly SqlValue[]
	| { readonly [k: string]: SqlValue };

interface SqlSslWire {
	readonly ca?: string;
	readonly cert?: string;
	readonly key?: string;
	readonly rejectUnauthorized?: boolean;
	readonly servername?: string;
}

interface SqlConnectionObjectWire {
	readonly connectionString?: string;
	readonly host?: string;
	readonly port?: number;
	readonly user?: string;
	readonly password?: string;
	readonly database?: string;
	readonly ssl?: boolean | SqlSslWire;
}

type SqlConnectionWire = string | SqlConnectionObjectWire;

interface SqlOptionsWire {
	readonly timeoutMs?: number;
}

interface SqlInputWire {
	readonly connection: SqlConnectionWire;
	readonly query: string;
	readonly params: readonly SqlParam[];
	readonly options?: SqlOptionsWire;
}

interface SqlColumnMetaWire {
	readonly name: string;
	// biome-ignore lint/style/useNamingConvention: matches node-postgres and porsager/postgres's own ColumnMeta field name; renaming would desync the wire contract with driver-derived metadata
	readonly dataTypeID: number;
}

interface SqlRowWire {
	readonly [k: string]: SqlValue;
}

interface SqlResultWire {
	readonly rows: readonly SqlRowWire[];
	readonly columns: readonly SqlColumnMetaWire[];
	readonly rowCount: number;
}

interface SqlErrorWire {
	readonly message: string;
	readonly code?: string;
}

export type {
	SqlColumnMetaWire,
	SqlConnectionObjectWire,
	SqlConnectionWire,
	SqlErrorWire,
	SqlInputWire,
	SqlOptionsWire,
	SqlParam,
	SqlResultWire,
	SqlRowWire,
	SqlSslWire,
	SqlValue,
};
