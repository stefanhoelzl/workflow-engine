// Skip-map lookup for the WPT runner. See ../README.md §"skip.ts conventions".

function splitKey(key: string): { file: string; subtest: string | null } {
	const idx = key.indexOf(":");
	if (idx < 0) {
		return { file: key, subtest: null };
	}
	return { file: key.slice(0, idx), subtest: key.slice(idx + 1) };
}

const REGEX_CACHE = new Map<string, RegExp>();

function globToRegex(pattern: string): RegExp {
	const cached = REGEX_CACHE.get(pattern);
	if (cached !== undefined) {
		return cached;
	}
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
		} else if (c && /[.+^${}()|[\]\\]/.test(c)) {
			src += `\\${c}`;
		} else if (c !== undefined) {
			src += c;
		}
	}
	const re = new RegExp(`^${src}$`);
	REGEX_CACHE.set(pattern, re);
	return re;
}

function matchPattern(pattern: string, key: string): boolean {
	const p = splitKey(pattern);
	const k = splitKey(key);
	if (p.subtest !== null && k.subtest === null) {
		return false;
	}
	if (!globToRegex(p.file).test(k.file)) {
		return false;
	}
	if (p.subtest === null) {
		return true;
	}
	// Subtest names are matched literally (no glob), to avoid surprises when
	// names themselves contain `*`.
	return p.subtest === k.subtest;
}

const GLOBS_CACHE = new WeakMap<
	object,
	ReadonlyArray<readonly [string, string]>
>();

function globEntries(
	skip: Record<string, string>,
): ReadonlyArray<readonly [string, string]> {
	let cached = GLOBS_CACHE.get(skip);
	if (cached === undefined) {
		cached = Object.entries(skip).filter(([k]) => k.includes("*"));
		GLOBS_CACHE.set(skip, cached);
	}
	return cached;
}

function findReason(skip: Record<string, string>, key: string): string | null {
	if (skip[key] !== undefined) {
		return skip[key];
	}
	for (const [pattern, reason] of globEntries(skip)) {
		if (matchPattern(pattern, key)) {
			return reason;
		}
	}
	return null;
}

const SUBTEST_INDEX_CACHE = new WeakMap<object, Map<string, string[]>>();

function declaredSubtestSkips(
	skip: Record<string, string>,
	path: string,
): readonly string[] {
	let cached = SUBTEST_INDEX_CACHE.get(skip);
	if (cached === undefined) {
		cached = new Map();
		for (const key of Object.keys(skip)) {
			const colon = key.indexOf(":");
			if (colon < 0) {
				continue;
			}
			const file = key.slice(0, colon);
			const name = key.slice(colon + 1);
			const arr = cached.get(file) ?? [];
			arr.push(name);
			cached.set(file, arr);
		}
		SUBTEST_INDEX_CACHE.set(skip, cached);
	}
	return cached.get(path) ?? [];
}

function findMissingSubtestSkips(
	declared: readonly string[],
	observed: readonly { name: string }[],
): string[] {
	if (declared.length === 0) {
		return [];
	}
	const observedNames = new Set(observed.map((r) => r.name));
	return declared.filter((n) => !observedNames.has(n));
}

export { declaredSubtestSkips, findMissingSubtestSkips, findReason };
