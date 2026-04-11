interface NavItem {
	href: string;
	label: string;
	icon: string;
}

const NAV_ITEMS: NavItem[] = [
	{ href: "/dashboard", label: "Dashboard", icon: "D" },
	{ href: "/trigger", label: "Trigger", icon: "T" },
];

function renderNav(activePath: string): string {
	return NAV_ITEMS.map(
		(item) =>
			`<a class="nav-item${activePath === item.href ? " active" : ""}" href="${item.href}">
        <span class="nav-icon">${item.icon}</span>
        <span class="nav-label">${item.label}</span>
      </a>`,
	).join("\n      ");
}

import { escapeHtml } from "./html.js";

interface LayoutOptions {
	title: string;
	activePath: string;
	user: string;
	email: string;
	head?: string;
	bodyAttrs?: string;
}

function renderLayout(options: LayoutOptions, content: string): string {
	const { title, activePath, user, email, head, bodyAttrs } = options;

	const userSection = user
		? `<div class="topbar-user">
      <div class="topbar-user-line">
        <span class="topbar-username">${escapeHtml(user)}</span>
        <a class="topbar-signout" href="/oauth2/sign_out?rd=%2Foauth2%2Fsign_in%3Finfo%3DSigned%2Bout">Sign out</a>
      </div>
      ${email ? `<div class="topbar-email">${escapeHtml(email)}</div>` : ""}
    </div>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="/static/workflow-engine.css">
  <script defer src="/static/alpine.js"></script>
  <script src="/static/htmx.js"></script>
${head ?? ""}
</head>
<body${bodyAttrs ? ` ${bodyAttrs}` : ""}>

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
