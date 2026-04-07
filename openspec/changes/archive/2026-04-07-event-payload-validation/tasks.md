## 1. PayloadValidationError

- [x] 1.1 Create `PayloadValidationError` class in `packages/runtime/src/context/payload-validation-error.ts` with `eventType`, `issues: { path: string; message: string }[]`, and `cause` properties
- [x] 1.2 Add unit tests for `PayloadValidationError`: invalid payload case (with issues), unknown event type case (empty issues)

## 2. ContextFactory validation

- [x] 2.1 Add `schemas: Record<string, { parse(data: unknown): unknown }>` parameter to `ContextFactory` constructor
- [x] 2.2 Validate payload in `#createAndEnqueue`: look up schema by event type, throw `PayloadValidationError` if not found, call `schema.parse(payload)`, use parsed output as event payload
- [x] 2.3 Catch the error from `schema.parse()` and wrap it in `PayloadValidationError` with mapped issues (`{ path: issue.path.join('.'), message: issue.message }`)
- [x] 2.4 Extract a `createTestFactory()` helper in `context.test.ts` with default passthrough schemas and update all existing tests to use it
- [x] 2.5 Add validation-specific tests: valid payload enqueued with parsed output, invalid payload throws `PayloadValidationError`, unknown event type throws `PayloadValidationError`

## 3. HTTP 422 response

- [x] 3.1 Catch `PayloadValidationError` in `httpTriggerMiddleware` and return 422 with `{ error, event, issues }` body
- [x] 3.2 Add tests for HTTP trigger: malformed payload returns 422 with structured body, valid payload passes through, invalid JSON still returns 400

## 4. Wire up and integration

- [x] 4.1 Pass `config.events` to `ContextFactory` in `main.ts`
- [x] 4.2 Update integration tests to pass schemas to `ContextFactory`
- [x] 4.3 Update event spec (`openspec/specs/events/spec.md`) to replace "compile-time only" requirement with runtime validation semantics
- [x] 4.4 Update context spec (`openspec/specs/context/spec.md`) to include schemas parameter in `ContextFactory` requirement
