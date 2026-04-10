## 1. SDK: `http()` helper and `TriggerDef` type

- [x] 1.1 Define `TriggerDef<S>` interface carrying trigger config + generated schema
- [x] 1.2 Implement `http(config)` function that wraps body schema with `{ body, headers, path, method }` and returns `TriggerDef`
- [x] 1.3 Add tests for `http()`: with body schema, without body schema, with response config, type inference

## 2. SDK: Phase-typed builder with dual type pools

- [x] 2.1 Define `TriggerPhase<T>`, `EventPhase<T, E>`, `ActionPhase<T, E>` interfaces with correct method signatures and phase transitions
- [x] 2.2 Implement unique name enforcement via `Name extends keyof T | keyof E ? never : Name` conditional types on `.trigger()` and `.event()`
- [x] 2.3 Update `.trigger()` to accept `TriggerDef<S>`, add schema to `T` pool, use trigger name as event name
- [x] 2.4 Restrict `.action()` `emits` to `keyof E` only (action events), keep `on` as `keyof (T & E)`
- [x] 2.5 Update `WorkflowBuilderImpl` runtime: store trigger-owned events in events map from trigger name + `TriggerDef` schema, drop `event` field from trigger config
- [x] 2.6 Update `.compile()` to emit trigger-owned events into `events` array and omit `event` field from trigger entries
- [x] 2.7 Add type-level tests: phase transitions, unique name rejection, emit constraint, payload typing for trigger and action events
- [x] 2.8 Update `ManifestSchema` to remove `event` field from trigger entries

## 3. SDK: Exports and workflow migration

- [x] 3.1 Export `http` and `TriggerDef` from `@workflow-engine/sdk`
- [x] 3.2 Migrate `workflows/cronitor.ts` to new API: `.trigger("webhook.cronitor", http({...}))`, update action handler to access `payload.body.*`

## 4. Runtime: HTTP trigger middleware payload construction

- [x] 4.1 Update `HttpTriggerDefinition` and `HttpTriggerResolved` types: remove `event` field, use `name` as event name
- [x] 4.2 Update `httpTriggerMiddleware` to construct `{ body, headers, path, method }` payload from the request
- [x] 4.3 Change JSON parse failure response from 400 to 422
- [x] 4.4 Pass `definition.name` as event type and source name to `source.create()`
- [x] 4.5 Add unit tests: full payload shape, headers forwarding, path with query string, method included, 422 on parse failure

## 5. Runtime: Loader and trigger registry

- [x] 5.1 Update workflow loader to resolve trigger event name from `trigger.name` instead of `trigger.event`
- [x] 5.2 Update trigger UI middleware: event submission passes full payload shape to `source.create()`

## 6. Integration tests

- [x] 6.1 Update integration test payload assertions to expect `{ body, headers, path, method }` shape
- [x] 6.2 Add integration test verifying headers and path propagate through the full pipeline (HTTP request -> trigger -> action context)

## 7. Build system

- [x] 7.1 Update Vite plugin manifest generation to handle new compile output (no `event` field on triggers, trigger-owned events in events array)
