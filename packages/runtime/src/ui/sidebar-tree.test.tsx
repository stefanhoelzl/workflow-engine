import { describe, expect, it } from "vitest";
import type { WorkflowRegistry } from "../workflow-registry.js";
import type { TriggerPair } from "./invocations/removed-triggers.js";
import { buildSidebarData, SidebarTree } from "./sidebar-tree.js";
import { dom } from "./test-utils.js";

// Minimal registry stub: only repos() + list() are read by buildSidebarData.
function registryWith(
	entries: readonly {
		owner: string;
		repo: string;
		workflow: string;
		triggers: readonly { name: string; kind: string }[];
	}[],
): WorkflowRegistry {
	const repos = (owner: string) => [
		...new Set(entries.filter((e) => e.owner === owner).map((e) => e.repo)),
	];
	const list = (owner?: string, repo?: string) =>
		entries
			.filter((e) => e.owner === owner && e.repo === repo)
			.map((e) => ({
				owner: e.owner,
				repo: e.repo,
				workflow: { name: e.workflow },
				bundleSource: "",
				triggers: e.triggers,
			})) as unknown as ReturnType<WorkflowRegistry["list"]>;
	return {
		get size() {
			return entries.length;
		},
		owners: () => [...new Set(entries.map((e) => e.owner))],
		repos,
		pairs: () => entries.map((e) => ({ owner: e.owner, repo: e.repo })),
		list,
		registerOwner: async () => ({ ok: false, error: "unused" }) as never,
		recover: async () => undefined,
		getEntry: () => undefined,
		dispose: () => undefined,
	};
}

function render(
	registry: WorkflowRegistry,
	owners: readonly string[],
	triggerPairs: readonly TriggerPair[],
	active: Parameters<typeof SidebarTree>[0]["active"] = {},
): Document {
	const data = buildSidebarData(registry, owners, triggerPairs);
	return dom(
		String(<SidebarTree surface="/invocations" data={data} active={active} />),
	);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: cohesive test suite for one builder; splitting hides shared setup
describe("buildSidebarData — removed reconstruction", () => {
	it("renders a removed trigger as a muted archive-box leaf sorted after live", () => {
		const registry = registryWith([
			{
				owner: "t0",
				repo: "r0",
				workflow: "deploy",
				triggers: [{ name: "run", kind: "http" }],
			},
		]);
		const d = render(
			registry,
			["t0"],
			[{ owner: "t0", repo: "r0", workflow: "deploy", name: "legacy-run" }],
		);
		const leaves = [...d.querySelectorAll(".sidebar-triggers > li a")];
		// Live "run" first, removed "legacy-run" after.
		expect(leaves.map((a) => a.textContent?.trim())).toEqual([
			"run",
			"legacy-run",
		]);
		const removed = d.querySelector(
			'a[href="/invocations/t0/r0/deploy/legacy-run"]',
		);
		expect(removed?.className).toContain("sidebar-trigger--removed");
		expect(removed?.querySelector(".trigger-kind-icon--removed")).toBeTruthy();
		expect(removed?.getAttribute("title")).toContain(
			"no longer in current upload",
		);
		// Live leaf keeps its real kind icon, not the archive-box icon.
		const live = d.querySelector('a[href="/invocations/t0/r0/deploy/run"]');
		expect(live?.querySelector(".trigger-kind-icon--http")).toBeTruthy();
		expect(live?.className).not.toContain("removed");
	});

	it("renders a fully-removed workflow as a muted node sorted after live", () => {
		const registry = registryWith([
			{
				owner: "t0",
				repo: "r0",
				workflow: "build",
				triggers: [{ name: "push", kind: "http" }],
			},
		]);
		const d = render(
			registry,
			["t0"],
			[{ owner: "t0", repo: "r0", workflow: "imap-poll", name: "inbound" }],
		);
		const wfLinks = [...d.querySelectorAll(".sidebar-workflows > li > a")];
		expect(wfLinks.map((a) => a.textContent?.trim())).toEqual([
			"build",
			"imap-poll",
		]);
		const removed = d.querySelector('a[href="/invocations/t0/r0/imap-poll"]');
		expect(removed?.className).toContain("sidebar-workflow-link--removed");
		// Its trigger leaf is removed too.
		expect(
			d.querySelector('a[href="/invocations/t0/r0/imap-poll/inbound"]')
				?.className,
		).toContain("sidebar-trigger--removed");
	});

	it("renders a renamed trigger as both a live and an removed leaf", () => {
		const registry = registryWith([
			{
				owner: "t0",
				repo: "r0",
				workflow: "deploy",
				triggers: [{ name: "on-push", kind: "http" }],
			},
		]);
		const d = render(
			registry,
			["t0"],
			[{ owner: "t0", repo: "r0", workflow: "deploy", name: "main-push" }],
		);
		expect(
			d.querySelector('a[href="/invocations/t0/r0/deploy/on-push"]')?.className,
		).not.toContain("removed");
		expect(
			d.querySelector('a[href="/invocations/t0/r0/deploy/main-push"]')
				?.className,
		).toContain("sidebar-trigger--removed");
	});

	it("surfaces a repo that has only removed history (absent from registry.repos)", () => {
		const registry = registryWith([]); // no live workflows anywhere
		const d = render(
			registry,
			["t0"],
			[{ owner: "t0", repo: "ghost", workflow: "gone", name: "trig" }],
		);
		expect(d.querySelector('a[href="/invocations/t0/ghost"]')).toBeTruthy();
		expect(
			d.querySelector('a[href="/invocations/t0/ghost/gone/trig"]')?.className,
		).toContain("sidebar-trigger--removed");
	});

	it("highlights an removed node as active when the URL matches it", () => {
		const registry = registryWith([
			{ owner: "t0", repo: "r0", workflow: "deploy", triggers: [] },
		]);
		const d = render(
			registry,
			["t0"],
			[{ owner: "t0", repo: "r0", workflow: "deploy", name: "legacy-run" }],
			{ owner: "t0", repo: "r0", workflow: "deploy", trigger: "legacy-run" },
		);
		expect(
			d.querySelector('a[href="/invocations/t0/r0/deploy/legacy-run"]')
				?.className,
		).toContain("active");
	});

	it("does not reconstruct removed triggers when no pairs are supplied", () => {
		const registry = registryWith([
			{
				owner: "t0",
				repo: "r0",
				workflow: "deploy",
				triggers: [{ name: "run", kind: "http" }],
			},
		]);
		const data = buildSidebarData(registry, ["t0"]);
		const d = dom(
			String(<SidebarTree surface="/trigger" data={data} active={{}} />),
		);
		expect(d.querySelector(".sidebar-trigger--removed")).toBeNull();
		expect(d.querySelector(".trigger-kind-icon--removed")).toBeNull();
	});

	it("never assigns the removed sentinel kind to a live trigger", () => {
		const registry = registryWith([
			{
				owner: "t0",
				repo: "r0",
				workflow: "deploy",
				triggers: [
					{ name: "run", kind: "http" },
					{ name: "tick", kind: "cron" },
				],
			},
		]);
		const data = buildSidebarData(registry, ["t0"], []);
		const triggers = data.workflowsByPair["t0/r0"]?.[0]?.triggers ?? [];
		expect(triggers.map((t) => t.kind).sort()).toEqual(["cron", "http"]);
		expect(triggers.some((t) => t.kind === "removed")).toBe(false);
	});
});
