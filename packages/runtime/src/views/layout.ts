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

interface LayoutOptions {
	title: string;
	activePath: string;
	head?: string;
	bodyAttrs?: string;
}

function renderLayout(options: LayoutOptions, content: string): string {
	const { title, activePath, head, bodyAttrs } = options;
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script defer src="/dashboard/alpine.js"></script>
  <script src="/dashboard/htmx.js"></script>
  <style>
    :root {
      --bg: #ffffff;
      --bg-surface: #f8f9fa;
      --bg-elevated: #ffffff;
      --border: #e1e4e8;
      --text: #1a1a2e;
      --text-secondary: #5a6070;
      --text-muted: #8b8fa3;
      --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
      --shadow-lg: 0 4px 12px rgba(0,0,0,0.1);
      --radius: 8px;
      --radius-sm: 4px;
      --green: #22c55e;
      --green-bg: #f0fdf4;
      --green-border: #bbf7d0;
      --red: #ef4444;
      --red-bg: #fef2f2;
      --red-border: #fecaca;
      --yellow: #f59e0b;
      --yellow-bg: #fffbeb;
      --yellow-border: #fde68a;
      --grey: #94a3b8;
      --grey-bg: #f1f5f9;
      --grey-border: #cbd5e1;
      --accent: #6366f1;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
      --font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      --sidebar-width: 200px;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1117;
        --bg-surface: #161822;
        --bg-elevated: #1e2030;
        --border: #2e3148;
        --text: #e2e4f0;
        --text-secondary: #a0a4c0;
        --text-muted: #6b6f8a;
        --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
        --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
        --green-bg: #052e16;
        --green-border: #166534;
        --red-bg: #350a0a;
        --red-border: #7f1d1d;
        --yellow-bg: #3b2506;
        --yellow-border: #92400e;
        --grey-bg: #1e293b;
        --grey-border: #475569;
      }
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      display: flex;
      min-height: 100vh;
    }

    .sidebar {
      width: var(--sidebar-width);
      background: var(--bg-elevated);
      border-right: 1px solid var(--border);
      padding: 16px 0;
      flex-shrink: 0;
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
    }

    .sidebar-title {
      padding: 0 16px 16px;
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }

    .sidebar-title .icon {
      width: 20px;
      height: 20px;
      background: var(--accent);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 11px;
      font-weight: 700;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
    }

    .nav-item:hover {
      color: var(--text);
      background: var(--bg-surface);
    }

    .nav-item.active {
      color: var(--accent);
      background: var(--bg-surface);
    }

    .nav-icon {
      width: 24px;
      height: 24px;
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      font-family: var(--font-mono);
      flex-shrink: 0;
    }

    .nav-item.active .nav-icon {
      background: var(--accent);
      color: white;
    }

    .main-content {
      margin-left: var(--sidebar-width);
      flex: 1;
      min-width: 0;
    }

    [x-cloak] { display: none !important; }

    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
${head ?? ""}
</head>
<body${bodyAttrs ? ` ${bodyAttrs}` : ""}>

  <nav class="sidebar">
    <div class="sidebar-title">
      <span class="icon">W</span>
      Workflow Engine
    </div>
    ${renderNav(activePath)}
  </nav>

  <div class="main-content">
    ${content}
  </div>

</body>
</html>`;
}

export { renderLayout };
