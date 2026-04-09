## Context

The trigger UI auto-generates forms from Zod event schemas via JSON Schema + Jedison. Currently forms render empty — users must fill every field manually. For events with many fields this is tedious for testing.

Zod 4's `.meta()` API passes arbitrary metadata through to JSON Schema output (e.g. `.meta({ example: "X" })` produces `"example": "X"` in JSON Schema). Jedison auto-fills form inputs from JSON Schema `default` values.

The key insight: we can promote `example` to `default` in the JSON Schema passed to Jedison, while keeping the original Zod schema (without `.default()`) for server-side validation. This gives pre-filled forms without weakening validation.

## Goals / Non-Goals

**Goals:**
- Pre-fill trigger UI forms with example values defined via `.meta({ example: ... })` on Zod schema fields
- Maintain strict server-side validation — missing required fields must still fail
- Support nested object schemas

**Non-Goals:**
- Auto-generating synthetic examples from type information (e.g. string → "example")
- Auto-synthesizing array defaults from item-level examples
- Adding SDK helpers or Zod extensions — `.meta()` is sufficient
- Placeholder text for optional fields — all fields with examples are pre-filled uniformly

## Decisions

### 1. Use Zod 4 `.meta({ example: ... })` as the author API

**Choice:** Workflow authors attach examples directly to Zod fields using the built-in `.meta()` API.

**Alternatives considered:**
- Separate examples object alongside event registration — duplicates field names, changes SDK API
- SDK helper function `example(z.string(), "val")` — unnecessary wrapper, reads inside-out
- Monkey-patching `.example()` onto Zod classes — fragile, requires patching each type class individually

**Rationale:** `.meta()` is a first-class Zod 4 API that flows through to JSON Schema with zero custom plumbing. No SDK changes needed.

### 2. Promote `example` → `default` in JSON Schema for Jedison

**Choice:** Transform the JSON Schema in the middleware before Jedison renders it, copying `example` into `default` where no `default` already exists.

**Alternatives considered:**
- Pass a separate `data` object to Jedison's `Create()` — requires extracting examples into a parallel data structure, more complex
- Inject HTML placeholder attributes via post-render DOM walking — Jedison doesn't support placeholders, would be fragile

**Rationale:** Jedison already reads `default` from JSON Schema and auto-fills. A single-line addition to the existing schema walk handles it.

### 3. Fold into existing schema preparation function

**Choice:** Rename `simplifyNullable()` → `prepareSchema()` and add the example→default promotion to its existing recursive walk.

**Alternatives considered:**
- Separate `applyExampleDefaults()` function — two recursive walks over the same tree for no added clarity

**Rationale:** Both concerns (nullable simplification, example promotion) are schema transformations for the UI. One pass, one function, renamed to reflect its broader role.

### 4. Real `default` takes precedence over `example`

**Choice:** If a field has both `"default"` (from `z.default()`) and `"example"` (from `.meta()`), the existing `default` is preserved.

**Rationale:** Schema defaults have semantic meaning — they affect Zod's parsing behavior. Examples are UI hints only and should not override intentional defaults.

## Risks / Trade-offs

**[Risk] Authors may confuse `.meta({ example })` with `.default()`** → The distinction is documented by convention: `.default()` affects validation, `.meta({ example })` is UI-only. The separation is enforced by architecture (Zod schema vs JSON Schema are different objects).

**[Risk] Jedison may treat promoted defaults differently than real defaults in edge cases** → Jedison's `setDefaultValue()` simply calls `setValue(schemaDefault)` — it doesn't distinguish how the default got there. Verified in Jedison 1.11.1 source.

**[Trade-off] No auto-generated examples** → Authors must explicitly annotate fields. This is intentional: auto-generated values (empty strings, zeros) are rarely useful as examples and could be misleading.

**[Trade-off] Arrays require explicit array-level examples** → Item-level examples only appear when a user manually adds an array item. For pre-filled array rows, the author must add `.meta({ example: [...] })` on the array schema itself. This avoids magic synthesis logic.
