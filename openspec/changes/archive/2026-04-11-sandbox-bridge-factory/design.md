## Context

The sandbox module bridges host-side functions into a QuickJS WASM VM. Today, every bridge is hand-coded: extract args from QuickJS handles, call the host implementation, marshal the result back, dispose handles. Async bridges additionally create a deferred promise, resolve/reject it, and pump `executePendingJobs()`. This produces ~200 lines of near-identical boilerplate across `globals.ts` and `bridge.ts`.

Current file layout:
- `sandbox/globals.ts` — `btoa`, `atob`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`
- `sandbox/bridge.ts` — `ctx.emit`, `ctx.fetch`, `ctx.event` (static JSON), `ctx.env` (static JSON), `marshalResponse` (with `json()` and `text()` sub-bridges)
- `sandbox/index.ts` — `createSandbox()` factory, `SandboxResult` type, `spawn()` method

There is no `console` global and no structured record of bridge invocations.

## Goals / Non-Goals

**Goals:**
- Eliminate bridge boilerplate with a declarative factory
- Provide compile-time type safety between arg extractors and impl parameters
- Auto-log every bridge invocation with structured entries
- Add `console.*` globals that capture to the same log
- Surface logs in `SandboxResult` for both success and error paths

**Non-Goals:**
- Opaque ref store (no current use case; can be added later without breaking changes)
- Streaming response bodies or WebSocket handles
- Timer bridge refactoring (timers have fundamentally different lifecycle semantics)
- Changes to ActionContext or the host-side Logger
- Log persistence or forwarding (consumers of SandboxResult decide what to do with logs)

## Decisions

### D1: Typed extractor functions with property chains

Arg extractors are typed objects with `.optional` and `.rest` modifiers, not string descriptors.

```
b.arg.string              → (handle) => string
b.arg.json.optional       → (handle) => unknown | undefined
b.arg.json.rest           → (...handles) => unknown[]
```

The `impl` parameter types are inferred from the extractor tuple via mapped types. This gives compile-time safety without conditional type mappings over string literals.

**Alternative considered:** String descriptors (`"string"`, `"json?"`, `"...json"`) with conditional type mapping. Rejected because the type machinery is more complex and less discoverable — property chains get autocomplete support.

### D2: Namespaced marshal helpers

Marshal helpers live under `b.marshal.*` to avoid confusion with `b.arg.*`.

```
b.marshal.string    → vm.newString
b.marshal.number    → vm.newNumber
b.marshal.json      → vm.evalCode(JSON.stringify(...))
b.marshal.boolean   → vm.true / vm.false
b.marshal.void      → vm.undefined
```

Custom marshal functions are also supported: `marshal: (result) => marshalResponse(b, result)`.

### D3: Structured LogEntry without source/level fields

```
type LogEntry = {
  method: string;
  args: unknown[];
  status: "ok" | "failed";
  result?: unknown;
  error?: string;
  ts: number;
  durationMs?: number | undefined;
};
```

Method names are fully qualified to match the guest-side call path: `"btoa"`, `"ctx.fetch"`, `"console.log"`. This eliminates the need for a `source` field. A `level` field is unnecessary because error state is captured in `status` and console levels are encoded in the method name (`console.warn`, `console.error`).

**Alternative considered:** Separate `source: "console" | "bridge"` and `level: "info" | "warn" | "error" | "debug"` fields. Rejected because they are redundant with the method name and add filtering dimensions that don't carry independent information.

### D4: Optional method override for log names

The factory's `name` parameter is used for `vm.newFunction` and `vm.setProp`. An optional `method` field overrides the log entry method name for namespaced bridges:

```
b.async(ctxHandle, "fetch", {
  method: "ctx.fetch",   // log entry method name
  ...
});
```

Defaults to `name` when omitted (works for globals like `btoa`).

### D5: Console as no-op sync bridges

Console methods use `b.sync()` with a no-op impl. The auto-log captures method + args, which is all that's needed for console output. No separate console capture mechanism required.

```
b.sync(consoleObj, "log", {
  method: "console.log",
  args: [b.arg.json.rest],
  marshal: b.marshal.void,
  impl: () => {},
});
```

Console lives in `globals.ts` alongside other guest-VM globals.

### D6: Timers remain hand-coded with pushLog access

Timers register callbacks that fire later and manage a pending-callbacks Map — a fundamentally different lifecycle from the sync/async call-and-return pattern. They use `b.vm` and `b.runtime` for handle access and `b.pushLog()` to write log entries when desired.

### D7: Log everything including sub-bridges

Response sub-methods (`json()`, `text()`) produce their own log entries. A typical fetch-then-parse produces 2 entries (`ctx.fetch` + `json`). This is acceptable because the current codebase has only these two sub-bridges and the entries are useful for debugging response parsing failures.

### D8: Result field captures raw host return values

`LogEntry.result` stores the raw return from `impl`. For sync bridges like `btoa`, this is a clean string. For async bridges like `ctx.fetch`, this is a `Response` object (not serializable). Consumers handle formatting — the log is an in-memory array within a single spawn call, not a persistence format.

## Sequence: sync bridge call

```
Guest code          vm.newFunction callback          Host
─────────          ────────────────────────          ────
btoa("hello") ──▶  extract args via b.arg.string
                    record start time
                    ──────────────────────────────▶  impl("hello")
                    ◀──────────────────────────────  returns "aGVsbG8="
                    push LogEntry {method, args, status, result, ts, durationMs}
                    marshal result via b.marshal.string
               ◀──  return handle (VM takes ownership)
```

## Sequence: async bridge call

```
Guest code          vm.newFunction callback          Host
─────────          ────────────────────────          ────
ctx.fetch(url) ──▶  extract args via b.arg.string
                    create deferred = vm.newPromise()
               ◀──  return deferred.handle (VM takes ownership)
                    record start time
                    ──────────────────────────────▶  impl(url)
                                                     ... network I/O ...
                    ◀──────────────────────────────  resolves with Response
                    push LogEntry {method, args, status, result, ts, durationMs}
                    marshal result, deferred.resolve(handle), handle.dispose()
                    runtime.executePendingJobs()
Guest continues ◀──
```

## Risks / Trade-offs

**[Handle disposal asymmetry]** Sync bridges return the marshaled handle (VM owns it, must NOT dispose). Async bridges resolve the deferred then dispose their copy. The factory must handle both correctly.
  **Mitigation:** This matches the existing hand-coded pattern. The QuickJS docs explicitly state "VmFunctionImplementation should not free its return value." The factory encodes this rule once.

**[Type machinery complexity]** ~15 lines of mapped/conditional types for arg inference. If it becomes unwieldy, can fall back to explicit impl signatures.
  **Mitigation:** The type machinery is isolated in bridge-factory.ts. Callers see clean inferred types at each call site.

**[Response objects in LogEntry.result]** `ctx.fetch` logs store a Response reference, which is not serializable and holds a body stream.
  **Mitigation:** Logs are an in-memory array scoped to a single spawn call. The Response is already consumed by the action. No persistence format depends on result serializability.

**[Sub-bridge log noise]** Each `response.json()` or `response.text()` call adds a log entry.
  **Mitigation:** Only 2 sub-bridges exist. The entries are useful for debugging. Volume is bounded by the number of fetch calls in a single action.
