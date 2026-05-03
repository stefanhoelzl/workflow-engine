// Shared in-page surface tabs (Dashboard | Trigger), rendered by Layout's
// `tabs?` slot on every authenticated UI surface. The active tab matches
// the current URL prefix; both tab hrefs swap the prefix while preserving
// the rest of the path, so a click is a pure surface swap that keeps the
// user's selected scope intact.

type Surface = "/dashboard" | "/trigger";

interface TabsProps {
	readonly surface: Surface;
	readonly path: string;
}

const TABS: readonly { surface: Surface; label: string }[] = [
	{ surface: "/dashboard", label: "Dashboard" },
	{ surface: "/trigger", label: "Trigger" },
];

function Tabs({ surface, path }: TabsProps) {
	return (
		<nav class="page-tabs" aria-label="Surface">
			{TABS.map((tab) => {
				const cls =
					tab.surface === surface ? "page-tabs-link active" : "page-tabs-link";
				return (
					<a class={cls} href={`${tab.surface}${path}`}>
						{tab.label}
					</a>
				);
			})}
		</nav>
	);
}

export type { TabsProps };
export { Tabs };
