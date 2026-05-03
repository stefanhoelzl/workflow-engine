import { describe, expect, it } from "vitest";
import { Tabs } from "./tabs.js";
import { dom } from "./test-utils.js";

const STYLE_ATTR_RE = /style="/;
const STYLE_TAG_RE = /<style/;
const SCRIPT_TAG_RE = /<script/;
const EVENT_HANDLER_RE = /\son\w+=/;
const ALPINE_STYLE_RE = /:style="/;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: cohesive test suite for one component; splitting hides shared setup
describe("<Tabs>", () => {
	it("renders both tabs always", () => {
		const html = String(<Tabs surface="/dashboard" path="" />);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links).toHaveLength(2);
		expect(links[0]?.textContent).toBe("Dashboard");
		expect(links[1]?.textContent).toBe("Trigger");
	});

	it("marks Dashboard active when surface=/dashboard", () => {
		const html = String(<Tabs surface="/dashboard" path="/acme" />);
		const d = dom(html);
		expect(d.querySelector('a[href="/dashboard/acme"]')?.className).toBe(
			"page-tabs-link active",
		);
		expect(d.querySelector('a[href="/trigger/acme"]')?.className).toBe(
			"page-tabs-link",
		);
	});

	it("marks Trigger active when surface=/trigger", () => {
		const html = String(<Tabs surface="/trigger" path="/acme/foo" />);
		const d = dom(html);
		expect(d.querySelector('a[href="/dashboard/acme/foo"]')?.className).toBe(
			"page-tabs-link",
		);
		expect(d.querySelector('a[href="/trigger/acme/foo"]')?.className).toBe(
			"page-tabs-link active",
		);
	});

	it.each([
		["", "/dashboard", "/trigger"],
		["/acme", "/dashboard/acme", "/trigger/acme"],
		["/acme/foo", "/dashboard/acme/foo", "/trigger/acme/foo"],
		[
			"/acme/foo/deploy",
			"/dashboard/acme/foo/deploy",
			"/trigger/acme/foo/deploy",
		],
		[
			"/acme/foo/deploy/run",
			"/dashboard/acme/foo/deploy/run",
			"/trigger/acme/foo/deploy/run",
		],
	])("preserves path %s in both tab hrefs", (path, dashHref, trigHref) => {
		const html = String(<Tabs surface="/dashboard" path={path} />);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links[0]?.getAttribute("href")).toBe(dashHref);
		expect(links[1]?.getAttribute("href")).toBe(trigHref);
	});

	it("emits no inline style/script/handler attributes (CSP)", () => {
		const html = String(<Tabs surface="/dashboard" path="/x/y/z/q" />);
		expect(html).not.toMatch(STYLE_ATTR_RE);
		expect(html).not.toMatch(STYLE_TAG_RE);
		expect(html).not.toMatch(SCRIPT_TAG_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(ALPINE_STYLE_RE);
	});
});
