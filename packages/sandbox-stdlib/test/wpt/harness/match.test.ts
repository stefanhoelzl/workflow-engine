import { describe, expect, it } from "vitest";
import {
	declaredSubtestSkips,
	findMissingSubtestSkips,
	findReason,
} from "./match.js";

describe("findReason", () => {
	it("returns null when nothing matches (implicit pass)", () => {
		expect(findReason({}, "a.any.js")).toBeNull();
		expect(
			findReason({ "fetch/api/**": "needs Request" }, "url/foo.any.js"),
		).toBeNull();
	});

	it("exact key match wins (literal lookup)", () => {
		expect(findReason({ "a/b.any.js": "exact" }, "a/b.any.js")).toBe("exact");
		expect(findReason({ "a/b.any.js": "no" }, "a/c.any.js")).toBeNull();
	});

	it("** glob matches any path", () => {
		expect(findReason({ "**": "all" }, "a/b/c.any.js")).toBe("all");
		expect(
			findReason({ "fetch/api/**": "r" }, "fetch/api/basic/x.any.js"),
		).toBe("r");
		expect(
			findReason({ "fetch/api/**": "r" }, "fetch/other/x.any.js"),
		).toBeNull();
	});

	it("* does not match slashes", () => {
		expect(findReason({ "a/*.any.js": "r" }, "a/b.any.js")).toBe("r");
		expect(findReason({ "a/*.any.js": "r" }, "a/b/c.any.js")).toBeNull();
	});

	it("filename glob anywhere in tree", () => {
		const skip = { "**/idlharness-*.any.js": "r" };
		expect(findReason(skip, "dom/events/idlharness-foo.any.js")).toBe("r");
		expect(findReason(skip, "dom/events/other.any.js")).toBeNull();
	});

	it("file-level glob matches any subtest of any covered file", () => {
		expect(
			findReason(
				{ "streams/**": "needs streams polyfill" },
				"streams/foo.any.js:bar",
			),
		).toBe("needs streams polyfill");
	});

	it("subtest-level pattern only matches subtest keys", () => {
		expect(
			findReason({ "a/b.any.js:sub name": "r" }, "a/b.any.js:sub name"),
		).toBe("r");
		expect(findReason({ "a/b.any.js:x": "r" }, "a/b.any.js:y")).toBeNull();
		expect(findReason({ "a/b.any.js:x": "r" }, "a/b.any.js")).toBeNull();
	});

	it("exact subtest match wins over file-level glob", () => {
		const skip = {
			"streams/**": "broad",
			"streams/foo.any.js:specific": "narrow",
		};
		expect(findReason(skip, "streams/foo.any.js:specific")).toBe("narrow");
	});
});

describe("declaredSubtestSkips", () => {
	it("returns empty list when no subtest entries match the path", () => {
		expect(declaredSubtestSkips({}, "foo.any.js")).toEqual([]);
		expect(
			declaredSubtestSkips({ "other.any.js:x": "r" }, "foo.any.js"),
		).toEqual([]);
	});

	it("returns subtest names for matching path-prefixed entries", () => {
		const skip = {
			"foo.any.js:one": "r1",
			"foo.any.js:two": "r2",
			"foo.any.js": "file-level",
			"bar.any.js:other": "r3",
		};
		expect([...declaredSubtestSkips(skip, "foo.any.js")].sort()).toEqual([
			"one",
			"two",
		]);
	});

	it("preserves literal subtest names containing wildcard chars", () => {
		const skip = { "foo.any.js:glob*name": "r" };
		expect(declaredSubtestSkips(skip, "foo.any.js")).toEqual(["glob*name"]);
	});
});

describe("findMissingSubtestSkips", () => {
	it("returns empty list when no declared skips", () => {
		expect(findMissingSubtestSkips([], [])).toEqual([]);
	});

	it("returns empty list when every declared skip was observed", () => {
		const observed = [{ name: "a" }, { name: "b" }, { name: "c" }];
		expect(findMissingSubtestSkips(["a", "b"], observed)).toEqual([]);
	});

	it("returns names of declared skips that were not observed (drift signal)", () => {
		const observed = [{ name: "still here" }];
		expect(
			findMissingSubtestSkips(["renamed upstream", "still here"], observed),
		).toEqual(["renamed upstream"]);
	});

	it("returns all declared names when nothing was observed", () => {
		expect(findMissingSubtestSkips(["x", "y"], [])).toEqual(["x", "y"]);
	});
});
