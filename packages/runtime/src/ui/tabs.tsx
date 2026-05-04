// Shared in-page surface tabs (Invocations | Trigger | Queues), rendered by
// Layout's `tabs?` slot on every authenticated UI surface. The active tab
// matches the current URL prefix; tab hrefs swap the prefix while preserving
// the rest of the path, so a click is a pure surface swap that keeps the
// user's selected scope intact.
//
// The tabbar also carries a left-aligned breadcrumb of the current scope
// (`All / owner / repo / workflow / trigger`); parent segments link to the
// current surface, the current segment is plain text. Navigation up the
// hierarchy stays inside the active surface.
//
// The Trigger label stays singular while Queues/Invocations are plural —
// asymmetry is deliberate per `shared-layout/spec.md`.

type Surface = "/invocations" | "/trigger" | "/queue";

interface TabsScope {
	readonly owner?: string;
	readonly repo?: string;
	readonly workflow?: string;
	readonly trigger?: string;
}

interface TabsProps {
	readonly surface: Surface;
	readonly path: string;
	readonly scope?: TabsScope;
}

const TABS: readonly { surface: Surface; label: string }[] = [
	{ surface: "/invocations", label: "Invocations" },
	{ surface: "/trigger", label: "Trigger" },
	{ surface: "/queue", label: "Queues" },
];

function Breadcrumb({
	surface,
	scope,
}: {
	surface: Surface;
	scope: TabsScope;
}) {
	const segments: { label: string; href?: string }[] = [];
	const rootHref = surface;
	const isAtRoot = !scope.owner;
	segments.push(isAtRoot ? { label: "All" } : { label: "All", href: rootHref });
	if (scope.owner) {
		const ownerHref = `${surface}/${scope.owner}`;
		segments.push(
			scope.repo
				? { label: scope.owner, href: ownerHref }
				: { label: scope.owner },
		);
	}
	if (scope.owner && scope.repo) {
		const repoHref = `${surface}/${scope.owner}/${scope.repo}`;
		segments.push(
			scope.workflow
				? { label: scope.repo, href: repoHref }
				: { label: scope.repo },
		);
	}
	if (scope.owner && scope.repo && scope.workflow) {
		const wfHref = `${surface}/${scope.owner}/${scope.repo}/${scope.workflow}`;
		segments.push(
			scope.trigger
				? { label: scope.workflow, href: wfHref }
				: { label: scope.workflow },
		);
	}
	if (scope.owner && scope.repo && scope.workflow && scope.trigger) {
		segments.push({ label: scope.trigger });
	}
	return (
		<nav class="page-tabs-breadcrumb" aria-label="Breadcrumb">
			{segments.map((seg, i) => (
				<>
					{i > 0 ? (
						<span class="page-tabs-breadcrumb-sep" aria-hidden="true">
							/
						</span>
					) : null}
					{seg.href ? (
						<a class="page-tabs-breadcrumb-link" href={seg.href}>
							{seg.label}
						</a>
					) : (
						<span class="page-tabs-breadcrumb-current">{seg.label}</span>
					)}
				</>
			))}
		</nav>
	);
}

function Tabs({ surface, path, scope }: TabsProps) {
	// Trigger-leaf URLs (`/<surface>/:owner/:repo/:workflow/:trigger`) have no
	// counterpart on `/queue` — queue identity is `(owner, repo, workflow,
	// queue)`, not trigger-keyed. The Queues tab is hidden at this scope so
	// users don't follow a tab into a 404. The Invocations and Trigger tabs
	// still render because both surfaces have valid trigger-leaf views.
	const visibleTabs = scope?.trigger
		? TABS.filter((tab) => tab.surface !== "/queue")
		: TABS;
	return (
		<div class="page-tabs-bar">
			<Breadcrumb surface={surface} scope={scope ?? {}} />
			<nav class="page-tabs" aria-label="Surface">
				{visibleTabs.map((tab) => {
					const cls =
						tab.surface === surface
							? "page-tabs-link active"
							: "page-tabs-link";
					return (
						<a class={cls} href={`${tab.surface}${path}`}>
							{tab.label}
						</a>
					);
				})}
			</nav>
		</div>
	);
}

export type { TabsProps, TabsScope };
export { Tabs };
