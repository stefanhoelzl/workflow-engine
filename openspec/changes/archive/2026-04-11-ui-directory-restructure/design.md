## Context

UI-related source files are spread across three top-level directories under `packages/runtime/src/`:
- `views/` — shared layout (1 file)
- `dashboard/` — routes, queries, and `views/` subdirectory (8 files)
- `trigger/` — routes and page rendering (2 files)

The `dashboard/views/` nesting is inconsistent with `trigger/` which has no `views/` subdirectory. This restructure consolidates everything under `src/ui/` with a flat internal structure, preparing for the upcoming unified styling work.

## Goals / Non-Goals

**Goals:**
- Group all UI code under `src/ui/`
- Flatten `dashboard/views/` into `ui/dashboard/` (remove unnecessary nesting)
- Update all import paths to match new locations
- Zero functional changes — all existing behavior preserved

**Non-Goals:**
- CSS extraction or modification (Phase B)
- Static asset serving changes (Phase B)
- oauth2-proxy template work (Phase A)
- Splitting trigger/middleware.ts into separate page/route files (Phase B)

## Decisions

### Move into `src/ui/` rather than top-level `ui/`

The TypeScript config includes `src/**/*` and Vite's SSR entry is `src/main.ts`. Placing `ui/` inside `src/` avoids any build config changes.

**Alternative considered**: `ui/` at `packages/runtime/ui/` — would require adding it to tsconfig `include` and creates two source roots that cross-reference each other.

### Flatten `dashboard/views/` into `ui/dashboard/`

Files in `dashboard/views/` (page.ts, list.ts, timeline.ts) only import from their sibling `queries.ts` and the shared `layout.ts`. Flattening simplifies imports: `"../queries.js"` becomes `"./queries.js"`.

**Alternative considered**: Keep the `views/` nesting — adds an unnecessary directory level with no organizational benefit at the current scale.

## Risks / Trade-offs

**[Risk] Open PRs or branches with old import paths** → This is the only active branch. No other branches at risk.

**[Trade-off] Git blame loses per-line history on moved files** → `git log --follow` still works. Acceptable for a one-time restructure.
