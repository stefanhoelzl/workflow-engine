## Why

UI code is scattered across `src/views/`, `src/dashboard/`, and `src/trigger/` with an inconsistent nesting pattern (`dashboard/views/` adds a sub-level that `trigger/` doesn't have). This makes the codebase harder to navigate and blocks the upcoming unified styling work (Phase B + A) which needs a clean `src/ui/` grouping.

## What Changes

- Move `src/views/layout.ts` into `src/ui/layout.ts`
- Move `src/dashboard/` into `src/ui/dashboard/`, flattening the `views/` subdirectory (files in `dashboard/views/` move up one level into `ui/dashboard/`)
- Move `src/trigger/` into `src/ui/trigger/`
- Update all import paths across moved files and `src/main.ts`
- Delete the now-empty `src/views/`, `src/dashboard/`, and `src/trigger/` directories

No functional, CSS, or HTML changes. All tests continue to pass with updated paths.

## Capabilities

### New Capabilities

_None — this is a pure restructure with no new behavior._

### Modified Capabilities

_None — no spec-level behavior changes._

## Impact

- **Code**: 18 import path changes across 9 files (`main.ts` + 8 moved files)
- **Build**: No changes needed — `tsconfig.json` includes `src/**/*` and Vite follows imports from the entry point
- **Tests**: Import paths updated in `queries.test.ts`, `timeline.test.ts`, `middleware.test.ts` — no logic changes
