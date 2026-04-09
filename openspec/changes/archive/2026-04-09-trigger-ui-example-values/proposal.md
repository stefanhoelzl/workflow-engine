## Why

Trigger UI forms are empty by default. For events with many fields, users must manually fill in every value before they can submit a test event. Providing example values as pre-filled form data makes large forms immediately usable and gives users a starting point they can tweak.

These are explicitly _not_ schema defaults — omitting a required field must still fail server-side validation.

## What Changes

- Workflow authors can attach example values to Zod schema fields using `.meta({ example: ... })`, which Zod 4 passes through to JSON Schema as top-level `"example"` keys.
- The trigger middleware's schema preparation function promotes `example` values to `default` in the JSON Schema before passing it to Jedison, so forms render pre-filled.
- Server-side validation is unaffected — it uses the original Zod schema which has no `.default()`, so missing fields still fail.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `trigger-ui`: Add example-to-default promotion in schema preparation, enabling pre-filled forms from `.meta({ example: ... })` values on Zod event schemas

## Impact

- `packages/runtime/src/trigger/middleware.ts`: `simplifyNullable()` renamed to `prepareSchema()`, extended with example→default promotion logic
- No SDK changes — uses Zod 4's built-in `.meta()` API
- No client-side JS changes — Jedison natively reads `default` from JSON Schema
- No changes to QueueStore, manifest format, or sandbox boundary
