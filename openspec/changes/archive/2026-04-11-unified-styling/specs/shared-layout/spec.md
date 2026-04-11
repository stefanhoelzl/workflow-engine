## MODIFIED Requirements

### Requirement: Shared layout function
The system SHALL provide a `renderLayout(options, content)` function that returns a complete HTML document with a top bar, navigation sidebar, and content area. The `options` object SHALL include `title`, `activePath`, `user`, `email`, and optional `head` and `bodyAttrs` fields.

#### Scenario: Layout produces valid HTML shell
- **WHEN** `renderLayout({ title: "Trigger", activePath: "/trigger", user: "stefan", email: "stefan@example.com" }, "<div>content</div>")` is called
- **THEN** the result is a complete HTML document with `<!DOCTYPE html>`, `<head>`, and `<body>`
- **THEN** the `<title>` contains the provided title
- **THEN** the content string is injected into the main content area

### Requirement: Shared CSS variables
The layout SHALL reference an external CSS file at `/static/workflow-engine.css` via a `<link>` tag instead of inline `<style>`.

#### Scenario: External CSS referenced
- **WHEN** the layout is rendered
- **THEN** the HTML contains `<link href="/static/workflow-engine.css">` in the `<head>`
- **THEN** no inline `<style>` block with CSS variables is present

#### Scenario: Light mode variables
- **WHEN** the page is rendered in light mode
- **THEN** CSS variables `--bg`, `--bg-surface`, `--bg-elevated`, `--border`, `--text`, `--text-secondary`, `--text-muted`, `--green`, `--red`, `--yellow`, and `--accent` are defined on `:root` in the external CSS file

#### Scenario: Dark mode variables
- **WHEN** the user's system preference is dark mode
- **THEN** the CSS variables are overridden via `@media (prefers-color-scheme: dark)` with dark theme values in the external CSS file

### Requirement: Shared script tags
The layout SHALL include script tags referencing Alpine.js and HTMX served from the static middleware at `/static/` paths.

#### Scenario: Scripts included
- **WHEN** the layout is rendered
- **THEN** the HTML includes `<script defer src="/static/alpine.js">` and `<script src="/static/htmx.js">`

### Requirement: Application top bar
The layout SHALL render a full-width top bar above the sidebar and main content area, displaying application branding and authenticated user identity.

#### Scenario: Top bar with authenticated user
- **WHEN** the layout is rendered with `user` and `email` values
- **THEN** the top bar displays "Workflow Engine" branding on the left and the username with a "Sign out" link on the first line and the email as a muted caption below on the right

#### Scenario: Top bar without authenticated user
- **WHEN** the layout is rendered with empty `user` and `email` values
- **THEN** the top bar displays "Workflow Engine" branding on the left and the user section on the right is hidden

#### Scenario: Sign out link
- **WHEN** the user clicks the "Sign out" link in the top bar
- **THEN** the browser navigates to `/oauth2/sign_out`
