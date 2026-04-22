import type { Callable } from "./plugin.js";

type GuestValue =
	| null
	| boolean
	| number
	| string
	| readonly GuestValue[]
	| { readonly [key: string]: GuestValue };

interface ArgSpec<T> {
	readonly kind:
		| "string"
		| "number"
		| "boolean"
		| "object"
		| "array"
		| "callable"
		| "raw";
	readonly item?: ArgSpec<unknown>;
	readonly __phantom?: T;
}

interface ResultSpec<T> {
	readonly kind:
		| "string"
		| "number"
		| "boolean"
		| "object"
		| "array"
		| "void"
		| "raw";
	readonly item?: ResultSpec<unknown>;
	readonly __phantom?: T;
}

type ArgTypes<Args extends readonly ArgSpec<unknown>[]> = {
	readonly [K in keyof Args]: Args[K] extends ArgSpec<infer T> ? T : never;
};

type ResultType<R extends ResultSpec<unknown>> =
	R extends ResultSpec<infer T> ? T : never;

const Guest = {
	string(): ArgSpec<string> & ResultSpec<string> {
		return { kind: "string" };
	},
	number(): ArgSpec<number> & ResultSpec<number> {
		return { kind: "number" };
	},
	boolean(): ArgSpec<boolean> & ResultSpec<boolean> {
		return { kind: "boolean" };
	},
	object<T = Record<string, unknown>>(): ArgSpec<T> & ResultSpec<T> {
		return { kind: "object" };
	},
	array<T>(
		item: ArgSpec<T> & ResultSpec<T>,
	): ArgSpec<readonly T[]> & ResultSpec<readonly T[]> {
		return { kind: "array", item };
	},
	callable(): ArgSpec<Callable> {
		return { kind: "callable" };
	},
	raw(): ArgSpec<GuestValue> & ResultSpec<GuestValue> {
		return { kind: "raw" };
	},
	void(): ResultSpec<void> {
		return { kind: "void" };
	},
} as const;

export type { ArgSpec, ArgTypes, GuestValue, ResultSpec, ResultType };
export { Guest };
