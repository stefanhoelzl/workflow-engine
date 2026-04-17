import { IIFE_NAMESPACE } from "@workflow-engine/core";
import { ENTRY, POST_HARNESS, PREAMBLE } from "./preamble.js";

// Assemble the complete source evaluated inside a WPT sandbox. Eval order:
//   PREAMBLE  — stub browser globals
//   testharness.js
//   POST_HARNESS — register callbacks BEFORE test file runs (sync test()
//                  files can complete during eval)
//   deps — scripts pulled in via META: script=
//   file — the .any.js test file
//   ENTRY — define __wptEntry
//
// The whole bundle exports __wptEntry via the IIFE namespace the sandbox
// reads from.

interface ComposeArgs {
	preamble?: string;
	testharness: string;
	deps: readonly string[];
	file: string;
}

function compose(args: ComposeArgs): string {
	const preamble = args.preamble ?? PREAMBLE;
	const parts = [
		preamble,
		args.testharness,
		POST_HARNESS,
		...args.deps,
		args.file,
		ENTRY,
		`globalThis[${JSON.stringify(IIFE_NAMESPACE)}] = { __wptEntry: globalThis.__wptEntry };`,
	];
	return parts.join("\n;\n");
}

export type { ComposeArgs };
export { compose };
