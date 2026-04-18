import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

interface NavItem {
	href: string;
	label: string;
	icon: string;
}

const NAV_ITEMS: NavItem[] = [
	{ href: "/dashboard", label: "Dashboard", icon: "D" },
	{ href: "/trigger", label: "Trigger", icon: "T" },
];

function renderNav(activePath: string) {
	return NAV_ITEMS.map(
		(item) =>
			html`<a class="nav-item${activePath === item.href ? " active" : ""}" href="${item.href}">
        <span class="nav-icon">${item.icon}</span>
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
	tenants?: readonly string[];
	activeTenant?: string;
}

function renderTenantSelector(
	tenants: readonly string[],
	activeTenant: string | undefined,
	activePath: string,
) {
	if (tenants.length === 0) {
		return html`<div class="topbar-tenant empty" aria-label="No tenants available">
      <span class="topbar-tenant-label">Tenant</span>
      <span class="topbar-tenant-empty">(none)</span>
    </div>`;
	}
	const options = tenants.map(
		(t) =>
			html`<option value="${t}"${t === activeTenant ? raw(" selected") : ""}>${t}</option>`,
	);
	// No inline handlers (CSP §6). The `data-tenant-selector` hook in
	// /static/tenant-selector.js wires auto-submit on change.
	return html`<form class="topbar-tenant" method="get" action="${activePath}" data-tenant-selector>
      <label class="topbar-tenant-label" for="tenant-select">Tenant</label>
      <select id="tenant-select" name="tenant">
        ${options}
      </select>
      <button class="topbar-tenant-go" type="submit">Go</button>
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
		tenants,
		activeTenant,
	} = options;

	const tenantSection = tenants
		? renderTenantSelector(tenants, activeTenant, activePath)
		: "";

	const displayName = user || "anonymous";
	const userSection = html`<div class="topbar-user">
      <div class="topbar-user-line">
        <span class="topbar-username">${displayName}</span>
        ${
					user
						? html`<a class="topbar-signout" href="/oauth2/sign_out?rd=%2Foauth2%2Fsign_in%3Finfo%3DSigned%2Bout">Sign out</a>`
						: ""
				}
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
  <script defer src="/static/tenant-selector.js"></script>
${head ?? ""}
</head>
<body${bodyAttrs ? raw(` ${bodyAttrs}`) : ""}>

  <div class="topbar">
    <div class="topbar-brand">
      <span class="icon">W</span>
      Workflow Engine
    </div>
    <div class="topbar-right">
      ${tenantSection}
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
