## ADDED Requirements

### Requirement: SDK package has a build step
The SDK package SHALL have a `build` script in `package.json` that compiles the CLI entry point to `dist/cli.js`. This uses `tsc` with a build-specific tsconfig followed by a shebang insertion script. The build output is only the CLI binary; all other SDK source is consumed as TypeScript source via workspace protocol.

#### Scenario: SDK build produces CLI binary
- **WHEN** running `pnpm build` in the SDK package directory
- **THEN** `dist/cli.js` is produced with `#!/usr/bin/env node` shebang
- **THEN** no other compiled output is required

#### Scenario: Root build includes SDK
- **WHEN** running root `pnpm build`
- **THEN** the SDK build step runs (producing `dist/cli.js`)
