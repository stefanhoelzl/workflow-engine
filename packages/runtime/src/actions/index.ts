interface Action {
	name: string;
	on: string;
	env: Record<string, string>;
	source: string;
}

export type { Action };
