## ADDED Requirements

### Requirement: Vite config bundles the runtime into a single JS file

A `vite.config.ts` at the repository root SHALL configure an SSR build that takes `packages/runtime/src/main.ts` as the entry point and produces a single bundled JavaScript file in `dist/`.

#### Scenario: Build produces a single output file
- **WHEN** `pnpm build` is run
- **THEN** a single JS file SHALL be emitted at `dist/main.js`
- **AND** the file SHALL be executable by Node.js without any `node_modules`

### Requirement: All npm dependencies are bundled

The Vite build SHALL inline all npm dependencies (`hono`, `@hono/node-server`) into the output bundle. Node.js built-in modules (`node:http`, `node:http2`, etc.) SHALL be externalized.

#### Scenario: Bundle has no external npm imports
- **WHEN** the bundled `dist/main.js` is inspected
- **THEN** it SHALL NOT contain any `require()` or `import` statements referencing `hono` or `@hono/node-server`
- **AND** it SHALL contain references to Node.js built-in modules only as external imports

### Requirement: Build script is available from the root

The root `package.json` SHALL include a `build` script that runs the Vite build.

#### Scenario: pnpm build runs successfully
- **WHEN** `pnpm build` is run from the repository root
- **THEN** the Vite SSR build SHALL execute and produce the bundle in `dist/`
