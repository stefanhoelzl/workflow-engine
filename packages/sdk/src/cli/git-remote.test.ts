import { describe, expect, it } from "vitest";
import { parseGitRemoteUrl } from "./git-remote.js";

describe("parseGitRemoteUrl", () => {
	it("parses https with .git suffix", () => {
		expect(parseGitRemoteUrl("https://github.com/acme/foo.git")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("parses https without .git suffix", () => {
		expect(parseGitRemoteUrl("https://github.com/acme/foo")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("strips userinfo from https URLs", () => {
		expect(parseGitRemoteUrl("https://token@github.com/acme/foo.git")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("parses ssh colon form with .git", () => {
		expect(parseGitRemoteUrl("git@github.com:acme/foo.git")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("parses ssh colon form without .git", () => {
		expect(parseGitRemoteUrl("git@github.com:acme/foo")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("parses ssh:// protocol form", () => {
		expect(parseGitRemoteUrl("ssh://git@github.com/acme/foo.git")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("is case-insensitive about the host", () => {
		expect(parseGitRemoteUrl("https://GitHub.com/acme/foo")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parseGitRemoteUrl("  https://github.com/acme/foo.git\n")).toEqual({
			owner: "acme",
			repo: "foo",
		});
	});

	it("falls through on GitHub Enterprise / unknown hosts", () => {
		expect(
			parseGitRemoteUrl("https://github.enterprise.corp/acme/foo.git"),
		).toBeUndefined();
	});

	it("falls through on gitlab", () => {
		expect(parseGitRemoteUrl("git@gitlab.com:acme/foo.git")).toBeUndefined();
	});

	it("falls through on bitbucket ssh", () => {
		expect(parseGitRemoteUrl("git@bitbucket.org:acme/foo.git")).toBeUndefined();
	});

	it("falls through on empty input", () => {
		expect(parseGitRemoteUrl("")).toBeUndefined();
		expect(parseGitRemoteUrl("   ")).toBeUndefined();
	});

	it("falls through on ssh colon form with extra path segments", () => {
		expect(
			parseGitRemoteUrl("git@github.com:acme/foo/bar.git"),
		).toBeUndefined();
	});

	it("falls through when the path has more than two segments", () => {
		expect(
			parseGitRemoteUrl("https://github.com/acme/foo/bar.git"),
		).toBeUndefined();
	});

	it("falls through when only an owner is given", () => {
		expect(parseGitRemoteUrl("https://github.com/acme")).toBeUndefined();
	});
});
