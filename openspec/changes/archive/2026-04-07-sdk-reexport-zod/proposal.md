## Why

Workflow authors currently need to `import { z } from "zod"` separately alongside `import { defineWorkflow } from "@workflow-engine/sdk"`. Since the SDK depends on Zod and every workflow definition uses Zod schemas, re-exporting `z` from the SDK removes an extra dependency concern for authors and keeps the import to a single source.

## What Changes

- Re-export `z` from `@workflow-engine/sdk`
- Update `sample.ts` to import `z` from the SDK instead of directly from Zod
- Remove direct `zod` dependency from `@workflow-engine/runtime` (it gets Zod transitively through the SDK)

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `define-workflow`: SDK re-exports `z` from Zod

## Impact

- **SDK package**: One additional export (`z`)
- **Runtime package**: `zod` removed from direct dependencies (still available transitively via SDK)
- **No breaking changes**
