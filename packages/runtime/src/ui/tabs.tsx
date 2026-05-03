// Shared in-page surface tabs (Dashboard | Trigger), rendered by Layout's
// `tabs?` slot on every authenticated UI surface. The active tab matches
// the current URL prefix; both tab hrefs swap the prefix while preserving
// the rest of the path, so a click is a pure surface swap that keeps the
// user's selected scope intact.
//
// The tabbar also carries a left-aligned breadcrumb of the current scope
// (`All / owner / repo / workflow / trigger`); parent segments link to the
// current surface, the current segment is plain text. Navigation up the
// hierarchy stays inside the active surface.

type Surface = "/dashboard" | "/trigger";

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
	{ surface: "/dashboard", label: "Dashboard" },
	{ surface: "/trigger", label: "Trigger" },
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
	return (
		<div class="page-tabs-bar">
			<Breadcrumb surface={surface} scope={scope ?? {}} />
			<nav class="page-tabs" aria-label="Surface">
				{TABS.map((tab) => {
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
