// Ambient declarations for the WPT-harness guest context. These globals
// don't exist in Node's type environment — they are installed by the
// preamble (`__wpt`), provided by testharness.js once loaded
// (`add_result_callback`, `add_completion_callback`, `done`), or
// injected by the sandbox runner as a per-run extraMethod (`__wptReport`).
//
// This file is type-only and is never emitted into the preamble bundle.

declare global {
	var __wpt: {
		completed: boolean;
		resolvers: Array<() => void>;
		results: Array<{ name: string; status: string; message: string }>;
	};

	function add_result_callback(
		cb: (test: {
			name: string;
			status: number;
			message?: string | null;
		}) => void,
	): void;

	function add_completion_callback(cb: () => void): void;

	function done(): void;

	function __wptReport(name: string, status: string, message: string): void;
}

export {};
