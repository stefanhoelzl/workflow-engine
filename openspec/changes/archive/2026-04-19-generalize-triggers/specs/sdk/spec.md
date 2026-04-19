## ADDED Requirements

### Requirement: Trigger factories synthesise inputSchema and outputSchema

Every SDK trigger factory (currently `httpTrigger`) SHALL synthesise `inputSchema` and `outputSchema` on the branded trigger it returns. The factory SHALL derive these schemas from its kind-specific config without requiring the author to supply them. The schemas SHALL be Zod schemas that fully describe the handler's argument and return value.

The author-facing API SHALL remain unchanged — authors call `httpTrigger({ path, method, body, query, handler })` (and future per-kind factories) exactly as before. Workflow handlers SHALL NOT observe any change in their `payload` argument shape or return type.

#### Scenario: httpTrigger exposes synthesised schemas

- **GIVEN** `const t = httpTrigger({ path: "u/:id", body: z.object({ x: z.number() }), handler: async () => ({}) })`
- **WHEN** the returned value is inspected
- **THEN** `t.inputSchema` SHALL be a Zod schema validating `{ body, headers, url, method, params, query }`
- **AND** `t.outputSchema` SHALL be a Zod schema validating `{ status?, body?, headers? }`

#### Scenario: Author-facing API unchanged

- **GIVEN** a workflow using `httpTrigger({ path, method, body, query, handler })` written before this change
- **WHEN** the workflow is rebuilt with the new SDK
- **THEN** the handler signature and all TypeScript inference SHALL remain identical
- **AND** the only change SHALL be that `inputSchema` and `outputSchema` are now present on the returned trigger
