import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { TopBar } from "./icons.js";

interface LayoutProps {
	title: string;
	activePath: string;
	user: string;
	email: string;
	sidebarTree?: Child;
	tabs?: Child;
	children: Child;
}

function Layout({
	title,
	user,
	email,
	sidebarTree,
	tabs,
	children,
}: LayoutProps) {
	return (
		<>
			{raw("<!DOCTYPE html>")}
			<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta
						name="viewport"
						content="width=device-width, initial-scale=1.0"
					/>
					<title>{title}</title>
					<link rel="stylesheet" href="/static/workflow-engine.css" />
					<link rel="stylesheet" href="/static/trigger.css" />
					{/* json-tree.js MUST load before alpine.js so it can attach
					the `alpine:init` listener that registers `wfeJsonTree` /
					`wfeQueueCard`. Alpine's CSP build walks the DOM as soon as
					alpine.js finishes loading; any later registration is too
					late. */}
					<script defer={true} src="/static/json-tree.js" />
					<script defer={true} src="/static/alpine.js" />
					<script src="/static/htmx.js" />
					<script src="/static/jedison.js" />
					<script defer={true} src="/static/result-dialog.js" />
					<script defer={true} src="/static/local-time.js" />
					<script defer={true} src="/static/flamegraph.js" />
					<script defer={true} src="/static/trigger-forms.js" />
				</head>
				<body>
					<TopBar user={user} email={email} />

					{sidebarTree ? (
						<nav class="sidebar">
							<div class="sidebar-tree-wrap">{sidebarTree}</div>
						</nav>
					) : null}

					{tabs ? <div class="page-tabs-slot">{tabs}</div> : null}

					<div class="main-content">{children}</div>
				</body>
			</html>
		</>
	);
}

// ---------------------------------------------------------------------------
// Compatibility shim for un-migrated callers.
//
// `renderLayout(options, content)` keeps the legacy function-style API used
// by `dashboard/page.ts`, `trigger/page.ts` (still .ts, still using
// `html\`...\`` to build content) until those files migrate to .tsx and
// switch to `<Layout {...props}>{content}</Layout>` directly. The legacy
// `head`, `bodyAttrs`, and `owners` props are silently ignored — those
// surfaces are dropped in this change (`head` becomes universal script
// tags inside <Layout>; `bodyAttrs` was dead code; `owners` was retained
// only by tests).
//
// To delete: once every caller of `renderLayout(...)` has been migrated to
// `<Layout>` directly (see Groups 7, 9 of tasks.md), remove this shim and
// the `LayoutOptions` type export.
// ---------------------------------------------------------------------------

interface LayoutOptions {
	title: string;
	activePath: string;
	user: string;
	email: string;
	sidebarTree?: Child;
	tabs?: Child;
	// Legacy props — silently ignored. Kept for backward compat during
	// per-file migration; will be removed in cleanup.
	head?: Child;
	bodyAttrs?: string;
	owners?: readonly string[];
}

function renderLayout(options: LayoutOptions, content: Child) {
	const { title, activePath, user, email, sidebarTree, tabs } = options;
	const props = {
		title,
		activePath,
		user,
		email,
		...(sidebarTree === undefined ? {} : { sidebarTree }),
		...(tabs === undefined ? {} : { tabs }),
	};
	return <Layout {...props}>{content}</Layout>;
}

export type { LayoutOptions, LayoutProps };
export { Layout, renderLayout };
