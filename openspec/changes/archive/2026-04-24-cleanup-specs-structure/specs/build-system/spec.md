## REMOVED Requirements

### Requirement: Vite with Rolldown as build tool

**Reason**: `build-system` is a narrow bootstrap-era spec that only covered the "Vite exists" root dependency. Content is absorbed by `runtime-build` (which now owns the Vite SSR build) and `workflow-build` (the workflow plugin's Vite integration).

**Migration**: See `runtime-build` — requires Vite 8.x + Rolldown as the runtime's SSR bundler.

### Requirement: Per-package build configuration deferred

**Reason**: Requirement described a transitional state ("no build config exists yet"). That transition is long done; both `runtime-build` and `workflow-build` now have real build configurations.

**Migration**: See `runtime-build` for the SSR config at repo root; `workflow-build` for the per-workflow plugin config.

### Requirement: SDK package has a build step

**Reason**: Same umbrella-capability replacement. The SDK CLI build step is kept in scope but belongs under `runtime-build` (or an SDK-specific build section) rather than a generic `build-system` wrapper.

**Migration**: See `runtime-build` for the SDK CLI build step (`packages/sdk/package.json`'s `build` script producing `dist/cli.js` with shebang).
