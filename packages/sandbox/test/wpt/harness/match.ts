// Pattern matching for the WPT spec map.
//
// Keys in spec.ts are either file-paths (e.g. "fetch/api/basic/foo.any.js")
// or file:subtest (e.g. "foo.any.js:subtest name"). Patterns support glob
// wildcards `*` (matches anything except `/`) and `**` (matches anything
// including `/`).
//
// findMostSpecific returns the winning Expectation by rules:
//   1. Highest specificity wins. Specificity is non-wildcard char count in
//      the file-part; subtest-targeted patterns get a +1_000_000 boost.
//   2. Severity breaks ties: skip > pass.

type Expectation = { expected: "pass" } | { expected: "skip"; reason: string };

function splitKey(key: string): { file: string; subtest: string | null } {
	const idx = key.indexOf(":");
	if (idx < 0) {
		return { file: key, subtest: null };
	}
	return { file: key.slice(0, idx), subtest: key.slice(idx + 1) };
}

function globToRegex(pattern: string): RegExp {
	let src = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				src += ".*";
				i++;
			} else {
				src += "[^/]*";
			}
		} else if (c === "?") {
			src += "[^/]";
		} else if (c && /[.+^${}()|[\]\\]/.test(c)) {
			src += `\\${c}`;
		} else if (c !== undefined) {
			src += c;
		}
	}
	return new RegExp(`^${src}$`);
}

function matchPattern(pattern: string, key: string): boolean {
	const p = splitKey(pattern);
	const k = splitKey(key);
	if (p.subtest === null && k.subtest !== null) {
		// File-level pattern matches any subtest-level key if the file matches.
		return globToRegex(p.file).test(k.file);
	}
	if (p.subtest !== null && k.subtest === null) {
		// Subtest-level pattern never matches a file-only key.
		return false;
	}
	if (!globToRegex(p.file).test(k.file)) {
		return false;
	}
	if (p.subtest === null) {
		return true;
	}
	// Subtest names are matched literally (no glob), which avoids surprising
	// behavior when subtest names themselves contain characters like `*`.
	return p.subtest === k.subtest;
}

function specificity(pattern: string): number {
	const { file, subtest } = splitKey(pattern);
	const subtestBoost = subtest === null ? 0 : 1_000_000;
	const literalChars = file.replace(/[*?]/g, "").length;
	return subtestBoost + literalChars;
}

function findMostSpecific(
	spec: Record<string, Expectation>,
	key: string,
): Expectation | null {
	let winner: { pattern: string; exp: Expectation; score: number } | null =
		null;
	for (const [pattern, exp] of Object.entries(spec)) {
		if (!matchPattern(pattern, key)) {
			continue;
		}
		const score = specificity(pattern);
		if (
			winner === null ||
			score > winner.score ||
			(score === winner.score && isHigherSeverity(exp, winner.exp))
		) {
			winner = { pattern, exp, score };
		}
	}
	return winner ? winner.exp : null;
}

function isHigherSeverity(a: Expectation, b: Expectation): boolean {
	return a.expected === "skip" && b.expected === "pass";
}

export type { Expectation };
export { findMostSpecific, matchPattern, specificity, splitKey };
