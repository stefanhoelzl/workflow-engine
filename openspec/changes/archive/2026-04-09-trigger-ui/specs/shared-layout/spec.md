## ADDED Requirements

### Requirement: Shared layout function
The system SHALL provide a `renderLayout(title, content)` function that returns a complete HTML document with a navigation sidebar and content area.

#### Scenario: Layout produces valid HTML shell
- **WHEN** `renderLayout("Trigger", "<div>content</div>")` is called
- **THEN** the result is a complete HTML document with `<!DOCTYPE html>`, `<head>`, and `<body>`
- **THEN** the `<title>` contains the provided title
- **THEN** the content string is injected into the main content area

### Requirement: Navigation sidebar
The layout SHALL include a sidebar (~200px) with icon and text labels for navigating between pages.

#### Scenario: Sidebar contains navigation links
- **WHEN** the layout is rendered
- **THEN** the sidebar contains a link to `/dashboard/` labeled "Dashboard"
- **THEN** the sidebar contains a link to `/trigger/` labeled "Trigger"

### Requirement: Shared CSS variables
The layout SHALL define CSS custom properties for theming that all pages use.

#### Scenario: Light mode variables
- **WHEN** the page is rendered in light mode
- **THEN** CSS variables `--bg`, `--bg-surface`, `--bg-elevated`, `--border`, `--text`, `--text-secondary`, `--text-muted`, `--green`, `--red`, `--yellow`, and `--accent` are defined on `:root`

#### Scenario: Dark mode variables
- **WHEN** the user's system preference is dark mode
- **THEN** the CSS variables are overridden via `@media (prefers-color-scheme: dark)` with dark theme values

### Requirement: Shared script tags
The layout SHALL include script tags for Alpine.js and HTMX vendored from npm dependencies.

#### Scenario: Scripts included
- **WHEN** the layout is rendered
- **THEN** the HTML includes `<script>` tags referencing Alpine.js and HTMX served from dashboard routes
