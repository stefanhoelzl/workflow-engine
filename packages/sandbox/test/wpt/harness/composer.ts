import { ENTRY, POST_HARNESS, PREAMBLE } from "virtual:wpt-preamble";
import { IIFE_NAMESPACE } from "@workflow-engine/core";

// Assemble the complete source evaluated inside a WPT sandbox. Eval order:
//   PREAMBLE  — stub browser globals, install importScripts polyfill
//   SCRIPTS registry — populate __wptScripts and pre-mark inlined URLs
//                      as already loaded so importScripts re-requests are
//                      no-ops (testharness.js and META deps are inlined
//                      directly below and must not be re-eval'd)
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
	scripts?: Readonly<Record<string, string>>;
	// Vendor-relative paths of files inlined into this bundle (testharness
	// + META deps). Pre-marked as loaded so importScripts("/$path") calls
	// from the test do not re-eval them.
	inlinedPaths?: readonly string[];
}

function compose(args: ComposeArgs): string {
	const preamble = args.preamble ?? PREAMBLE;
	const scripts = args.scripts ?? {};
	const inlinedUrls = (args.inlinedPaths ?? []).map((p) => `/${p}`);
	const parts = [
		preamble,
		`Object.assign(globalThis.__wptScripts, ${JSON.stringify(scripts)});`,
		`for (const u of ${JSON.stringify(inlinedUrls)}) globalThis.__wptScriptsLoaded.add(u);`,
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
