interface Action {
	name: string;
	on: string;
	env: Record<string, string>;
	source: string;
	exportName: string;
}

export type { Action };
