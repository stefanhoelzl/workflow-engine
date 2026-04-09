## MODIFIED Requirements

### Requirement: Dashboard page route
The system SHALL serve a complete HTML page at `GET /dashboard` using the shared layout function, containing dashboard-specific content, styles, and HTMX attributes.

#### Scenario: Page load
- **WHEN** a browser requests `GET /dashboard`
- **THEN** the response is an HTML document produced by `renderLayout("Dashboard", dashboardContent)`
- **THEN** the HTML includes HTMX attributes to load the list fragment
- **THEN** the sidebar navigation is present with links to Dashboard and Trigger

#### Scenario: Dark/light mode
- **WHEN** the page is loaded
- **THEN** theming is provided by the shared layout's CSS variables
- **THEN** dashboard-specific styles reference these shared CSS variables
