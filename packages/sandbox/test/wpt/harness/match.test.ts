import { describe, expect, it } from "vitest";
import {
	type Expectation,
	findMostSpecific,
	matchPattern,
	specificity,
} from "./match.js";

describe("matchPattern", () => {
	it("exact file match", () => {
		expect(matchPattern("a/b.any.js", "a/b.any.js")).toBe(true);
		expect(matchPattern("a/b.any.js", "a/c.any.js")).toBe(false);
	});

	it("** matches any path", () => {
		expect(matchPattern("**", "a/b/c.any.js")).toBe(true);
		expect(matchPattern("fetch/api/**", "fetch/api/basic/x.any.js")).toBe(true);
		expect(matchPattern("fetch/api/**", "fetch/other/x.any.js")).toBe(false);
	});

	it("* does not match slashes", () => {
		expect(matchPattern("a/*.any.js", "a/b.any.js")).toBe(true);
		expect(matchPattern("a/*.any.js", "a/b/c.any.js")).toBe(false);
	});

	it("filename glob anywhere", () => {
		expect(
			matchPattern(
				"**/idlharness-*.any.js",
				"dom/events/idlharness-foo.any.js",
			),
		).toBe(true);
		expect(
			matchPattern("**/idlharness-*.any.js", "dom/events/other.any.js"),
		).toBe(false);
	});

	it("subtest-level pattern matches subtest-level key", () => {
		expect(matchPattern("a/b.any.js:sub name", "a/b.any.js:sub name")).toBe(
			true,
		);
		expect(matchPattern("a/b.any.js:x", "a/b.any.js:y")).toBe(false);
	});

	it("file-level pattern matches any subtest key of that file", () => {
		expect(matchPattern("a/b.any.js", "a/b.any.js:anything")).toBe(true);
	});

	it("subtest pattern never matches a file-only key", () => {
		expect(matchPattern("a/b.any.js:x", "a/b.any.js")).toBe(false);
	});
});

describe("specificity", () => {
	it("more non-wildcard characters wins", () => {
		expect(specificity("fetch/api/cors/**")).toBeGreaterThan(
			specificity("fetch/api/**"),
		);
	});

	it("filename pattern may beat dir pattern", () => {
		// "idlharness-.any.js" literal = 17
		// "dom/events/" literal = 11
		expect(specificity("**/idlharness-*.any.js")).toBeGreaterThan(
			specificity("dom/events/**"),
		);
	});

	it("subtest pattern beats any file pattern", () => {
		expect(specificity("a:b")).toBeGreaterThan(
			specificity(
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.any.js",
			),
		);
	});

	it("exact file beats glob", () => {
		expect(specificity("a/b.any.js")).toBeGreaterThan(specificity("a/**"));
	});
});

describe("findMostSpecific", () => {
	const pass: Expectation = { expected: "pass" };
	const skip = (r: string): Expectation => ({ expected: "skip", reason: r });

	it("returns null when no pattern matches", () => {
		expect(findMostSpecific({}, "a.any.js")).toBeNull();
	});

	it("most specific dir pattern wins", () => {
		const spec = {
			"fetch/api/**": skip("outer"),
			"fetch/api/cors/**": skip("inner"),
		};
		const r = findMostSpecific(spec, "fetch/api/cors/foo.any.js");
		expect(r?.expected).toBe("skip");
		expect((r as { reason: string }).reason).toBe("inner");
	});

	it("subtest pattern beats file pattern for subtest key", () => {
		const spec = {
			"a/b.any.js": pass,
			"a/b.any.js:one": skip("specific"),
		};
		const r = findMostSpecific(spec, "a/b.any.js:one");
		expect(r?.expected).toBe("skip");
	});

	it("file-level pass applies to any subtest of that file", () => {
		const spec = { "a/b.any.js": pass };
		const r = findMostSpecific(spec, "a/b.any.js:anything");
		expect(r?.expected).toBe("pass");
	});

	it("exact file beats shallow dir glob", () => {
		const spec = {
			"a/b.any.js": pass, // 10 literal chars
			"a/**": skip("glob"), // 2 literal chars
		};
		const r = findMostSpecific(spec, "a/b.any.js");
		expect(r?.expected).toBe("pass");
	});

	it("severity tiebreak: skip wins at equal specificity", () => {
		// Two patterns with identical literal-char counts (12 each).
		const spec = {
			"a/*/foo.any.js": pass,
			"*/b/foo.any.js": skip("skip wins"),
		};
		const r = findMostSpecific(spec, "a/b/foo.any.js");
		expect(r?.expected).toBe("skip");
	});

	it("catchall ** with dir override", () => {
		const spec = {
			"**": skip("not yet classified"),
			"encoding/**": pass,
		};
		expect(findMostSpecific(spec, "fetch/api/x.any.js")?.expected).toBe("skip");
		expect(findMostSpecific(spec, "encoding/x.any.js")?.expected).toBe("pass");
	});
});
