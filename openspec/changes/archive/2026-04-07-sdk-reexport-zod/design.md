## Context

The SDK already depends on Zod. Workflow authors always need `z` to define event schemas. Currently they import from two packages.

## Goals / Non-Goals

**Goals:**
- Single import source for workflow authors: `import { defineWorkflow, z } from "@workflow-engine/sdk"`

**Non-Goals:**
- Wrapping or abstracting Zod — this is a direct re-export

## Decisions

### 1. Direct re-export of `z`

Add `export { z } from "zod"` to the SDK's `index.ts`.

**Why:** Simplest approach. No wrapper, no abstraction. Workflow authors get the same `z` they'd get from importing Zod directly. Since the SDK already depends on Zod, this adds no new dependency.

## Risks / Trade-offs

None significant. The re-export is a convenience — authors can still import from `zod` directly if preferred.
