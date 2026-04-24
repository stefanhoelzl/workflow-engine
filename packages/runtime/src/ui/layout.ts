import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

// Inline-SVG icon set (lucide-style). `.icon` sizes + inherits currentColor.
const iconPaths = {
	// activity — dashboard
	dashboard: raw('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>') as HtmlEscapedString,
	// zap — trigger
	trigger: raw(
		'<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
	) as HtmlEscapedString,
	// workflow — brand mark (a small rounded-square "W"-ish glyph)
	brand: raw(
		'<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
	) as HtmlEscapedString,
	// chevron-right — shared expand affordance
	chevron: raw('<path d="m9 18 6-6-6-6"/>') as HtmlEscapedString,
};

function icon(name: keyof typeof iconPaths, extraClass?: string) {
	const cls = extraClass ? `icon ${extraClass}` : "icon";
	return html`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

interface NavItem {
	href: string;
	label: string;
	iconName: keyof typeof iconPaths;
}

const NAV_ITEMS: NavItem[] = [
	{ href: "/dashboard", label: "Dashboard", iconName: "dashboard" },
	{ href: "/trigger", label: "Trigger", iconName: "trigger" },
];

function renderNav(activePath: string) {
	return NAV_ITEMS.map(
		(item) =>
			html`<a class="nav-item${activePath === item.href ? " active" : ""}" href="${item.href}">
        <span class="nav-icon">${icon(item.iconName)}</span>
        <span class="nav-label">${item.label}</span>
      </a>`,
	);
}

interface LayoutOptions {
	title: string;
	activePath: string;
	user: string;
	email: string;
	head?: HtmlEscapedString | Promise<HtmlEscapedString>;
	bodyAttrs?: string;
	owners?: readonly string[];
	activeOwner?: string;
}

function renderOwnerSelector(
	owners: readonly string[],
	activeOwner: string | undefined,
	activePath: string,
) {
	if (owners.length === 0) {
		return html`<div class="topbar-owner empty" aria-label="No owners available">
      <span class="topbar-owner-label">Owner</span>
      <span class="topbar-owner-empty">(none)</span>
    </div>`;
	}
	const options = owners.map(
		(t) =>
			html`<option value="${t}"${t === activeOwner ? raw(" selected") : ""}>${t}</option>`,
	);
	// No inline handlers (CSP §6). The `data-owner-selector` hook in
	// /static/owner-selector.js wires auto-submit on change.
	return html`<form class="topbar-owner" method="get" action="${activePath}" data-owner-selector>
      <label class="topbar-owner-label" for="owner-select">Owner</label>
      <select id="owner-select" name="owner">
        ${options}
      </select>
      <button class="topbar-owner-go" type="submit">Go</button>
    </form>`;
}

function renderLayout(
	options: LayoutOptions,
	content: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
	const {
		title,
		activePath,
		user,
		email,
		head,
		bodyAttrs,
		owners,
		activeOwner,
	} = options;

	const ownerSection = owners
		? renderOwnerSelector(owners, activeOwner, activePath)
		: "";

	const displayName = user || "anonymous";
	const userSection = user
		? html`<div class="topbar-user" role="group" aria-label="Signed in as ${displayName}">
      <div class="topbar-user-line">
        <span class="topbar-username">${displayName}</span>
        <form class="topbar-signout-form" method="post" action="/auth/logout">
          <button class="topbar-signout" type="submit">Sign out</button>
        </form>
      </div>
      ${email ? html`<div class="topbar-email">${email}</div>` : ""}
    </div>`
		: html`<div class="topbar-user">
      <div class="topbar-user-line">
        <span class="topbar-username">${displayName}</span>
      </div>
      ${email ? html`<div class="topbar-email">${email}</div>` : ""}
    </div>`;

	return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="/static/workflow-engine.css">
  <script defer src="/static/alpine.js"></script>
  <script src="/static/htmx.js"></script>
  <script defer src="/static/result-dialog.js"></script>
  <script defer src="/static/owner-selector.js"></script>
  <script defer src="/static/local-time.js"></script>
${head ?? ""}
</head>
<body${bodyAttrs ? raw(` ${bodyAttrs}`) : ""}>

  <div class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${icon("brand")}</span>
      Workflow Engine
    </div>
    <div class="topbar-right">
      ${ownerSection}
      ${userSection}
    </div>
  </div>

  <nav class="sidebar">
    ${renderNav(activePath)}
  </nav>

  <div class="main-content">
    ${content}
  </div>

</body>
</html>`;
}

export type { LayoutOptions };
export { renderLayout };
