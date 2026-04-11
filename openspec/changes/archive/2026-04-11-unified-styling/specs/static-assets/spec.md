## ADDED Requirements

### Requirement: Static file serving middleware

The system SHALL provide a static file middleware that serves project files and vendor dependencies at the `/static/*` URL prefix.

#### Scenario: Serving a project CSS file
- **WHEN** a GET request is made to `/static/workflow-engine.css`
- **THEN** the response body contains the CSS file content, `Content-Type` is `text/css`, and `Cache-Control` is `public, max-age=31536000, immutable`

#### Scenario: Serving a vendor JS file
- **WHEN** a GET request is made to `/static/alpine.js`
- **THEN** the response body contains the Alpine.js library content and `Content-Type` is `application/javascript`

#### Scenario: Unknown file extension is not served
- **WHEN** a `.ts` file exists in the static directory
- **THEN** it is not served because `.ts` is not in the content type whitelist

#### Scenario: Non-existent static file
- **WHEN** a GET request is made to `/static/nonexistent.js`
- **THEN** the response status is 404

### Requirement: Build-time file discovery

The static middleware SHALL discover project files in its directory at build time via `import.meta.glob` and load vendor dependencies via explicit `?raw` imports.

#### Scenario: Adding a new CSS file
- **WHEN** a new `.css` file is added to `src/ui/static/`
- **THEN** it is automatically served at `/static/<filename>` after the next build without code changes

#### Scenario: Content type whitelist
- **WHEN** files are discovered by the glob
- **THEN** only files with extensions matching the content type whitelist (`.css`, `.js`) are served
