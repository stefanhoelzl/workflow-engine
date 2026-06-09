import { describe, expect, it } from "vitest";
import { Tabs } from "./tabs.js";
import { dom } from "./test-utils.js";

const STYLE_ATTR_RE = /style="/;
const STYLE_TAG_RE = /<style/;
const SCRIPT_TAG_RE = /<script/;
const EVENT_HANDLER_RE = /\son\w+=/;
const ALPINE_STYLE_RE = /:style="/;

// Number of in-page surface tabs rendered by <Tabs>. Kept as a named constant
// to satisfy biome's noMagicNumbers and to make the contract intent obvious.
const EXPECTED_TAB_COUNT = 3;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: cohesive test suite for one component; splitting hides shared setup
describe("<Tabs>", () => {
	it("renders all three tabs always", () => {
		const html = String(<Tabs surface="/invocations" path="" />);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links).toHaveLength(EXPECTED_TAB_COUNT);
		expect(links[0]?.textContent).toBe("Invocations");
		expect(links[1]?.textContent).toBe("Trigger");
		expect(links[2]?.textContent).toBe("Queues");
	});

	it("marks Invocations active when surface=/invocations", () => {
		const html = String(<Tabs surface="/invocations" path="/acme" />);
		const d = dom(html);
		expect(d.querySelector('a[href="/invocations/acme"]')?.className).toBe(
			"page-tabs-link active",
		);
		expect(d.querySelector('a[href="/trigger/acme"]')?.className).toBe(
			"page-tabs-link",
		);
		expect(d.querySelector('a[href="/queue/acme"]')?.className).toBe(
			"page-tabs-link",
		);
	});

	it("marks Trigger active when surface=/trigger", () => {
		const html = String(<Tabs surface="/trigger" path="/acme/foo" />);
		const d = dom(html);
		expect(d.querySelector('a[href="/invocations/acme/foo"]')?.className).toBe(
			"page-tabs-link",
		);
		expect(d.querySelector('a[href="/trigger/acme/foo"]')?.className).toBe(
			"page-tabs-link active",
		);
		expect(d.querySelector('a[href="/queue/acme/foo"]')?.className).toBe(
			"page-tabs-link",
		);
	});

	it("marks Queues active when surface=/queue", () => {
		const html = String(<Tabs surface="/queue" path="/acme/foo/build" />);
		const d = dom(html);
		expect(
			d.querySelector('a[href="/invocations/acme/foo/build"]')?.className,
		).toBe("page-tabs-link");
		expect(
			d.querySelector('a[href="/trigger/acme/foo/build"]')?.className,
		).toBe("page-tabs-link");
		expect(d.querySelector('a[href="/queue/acme/foo/build"]')?.className).toBe(
			"page-tabs-link active",
		);
	});

	it.each([
		["", "/invocations", "/trigger", "/queue"],
		["/acme", "/invocations/acme", "/trigger/acme", "/queue/acme"],
		[
			"/acme/foo",
			"/invocations/acme/foo",
			"/trigger/acme/foo",
			"/queue/acme/foo",
		],
		[
			"/acme/foo/deploy",
			"/invocations/acme/foo/deploy",
			"/trigger/acme/foo/deploy",
			"/queue/acme/foo/deploy",
		],
		[
			"/acme/foo/deploy/run",
			"/invocations/acme/foo/deploy/run",
			"/trigger/acme/foo/deploy/run",
			"/queue/acme/foo/deploy/run",
		],
	])("preserves path %s across all tab hrefs", (path, invHref, trigHref, queueHref) => {
		const html = String(<Tabs surface="/invocations" path={path} />);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links[0]?.getAttribute("href")).toBe(invHref);
		expect(links[1]?.getAttribute("href")).toBe(trigHref);
		expect(links[2]?.getAttribute("href")).toBe(queueHref);
	});

	it("hides the Queues tab on trigger-leaf URLs (scope.trigger set)", () => {
		const html = String(
			<Tabs
				surface="/trigger"
				path="/acme/foo/deploy/run"
				scope={{
					owner: "acme",
					repo: "foo",
					workflow: "deploy",
					trigger: "run",
				}}
			/>,
		);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links).toHaveLength(2);
		const hrefs = Array.from(links).map((l) => l.getAttribute("href"));
		expect(hrefs).toContain("/invocations/acme/foo/deploy/run");
		expect(hrefs).toContain("/trigger/acme/foo/deploy/run");
		expect(hrefs).not.toContain("/queue/acme/foo/deploy/run");
	});

	it("shows the Queues tab at workflow scope (scope.trigger absent)", () => {
		const html = String(
			<Tabs
				surface="/trigger"
				path="/acme/foo/deploy"
				scope={{ owner: "acme", repo: "foo", workflow: "deploy" }}
			/>,
		);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links).toHaveLength(EXPECTED_TAB_COUNT);
		expect(d.querySelector('a[href="/queue/acme/foo/deploy"]')).toBeTruthy();
	});

	it("hides Trigger and Queues tabs for an removed workflow scope", () => {
		const html = String(
			<Tabs
				surface="/invocations"
				path="/acme/foo/gone-wf"
				scope={{ owner: "acme", repo: "foo", workflow: "gone-wf" }}
				removed={true}
			/>,
		);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		// Only the current (Invocations) surface tab remains.
		expect(links).toHaveLength(1);
		expect(links[0]?.textContent).toBe("Invocations");
		expect(d.querySelector('a[href^="/trigger/"]')).toBeNull();
		expect(d.querySelector('a[href^="/queue/"]')).toBeNull();
	});

	it("hides the Trigger tab for an removed trigger scope", () => {
		const html = String(
			<Tabs
				surface="/invocations"
				path="/acme/foo/deploy/legacy-run"
				scope={{
					owner: "acme",
					repo: "foo",
					workflow: "deploy",
					trigger: "legacy-run",
				}}
				removed={true}
			/>,
		);
		const d = dom(html);
		const links = d.querySelectorAll("a.page-tabs-link");
		expect(links).toHaveLength(1);
		expect(links[0]?.textContent).toBe("Invocations");
	});

	it("emits no inline style/script/handler attributes (CSP)", () => {
		const html = String(<Tabs surface="/invocations" path="/x/y/z/q" />);
		expect(html).not.toMatch(STYLE_ATTR_RE);
		expect(html).not.toMatch(STYLE_TAG_RE);
		expect(html).not.toMatch(SCRIPT_TAG_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(ALPINE_STYLE_RE);
	});
});
