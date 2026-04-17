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
}

function renderLayout(
	options: LayoutOptions,
	content: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
	const { title, activePath, user, email, head, bodyAttrs } = options;

	const userSection = user
		? html`<div class="topbar-user">
      <div class="topbar-user-line">
        <span class="topbar-username">${user}</span>
        <a class="topbar-signout" href="/oauth2/sign_out?rd=%2Foauth2%2Fsign_in%3Finfo%3DSigned%2Bout">Sign out</a>
      </div>
      ${email ? html`<div class="topbar-email">${email}</div>` : ""}
    </div>`
		: "";

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
${head ?? ""}
</head>
<body${bodyAttrs ? raw(` ${bodyAttrs}`) : ""}>

  <div class="topbar">
    <div class="topbar-brand">
      <span class="icon">W</span>
      Workflow Engine
    </div>
    ${userSection}
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
