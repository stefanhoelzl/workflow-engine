# Design: plugin-worker-source-url

## Context

Each sandbox-stdlib plugin's host-side `workerSource` is a rollup bundle (esbuild transpile-only, no minify — function names survive) produced by the `?sandbox-plugin` vite transform and carried as an inert string in the plugin descriptor. At sandbox spawn, `loadPluginFromSource` (`packages/sandbox/src/worker-plugin-loader.ts`) imports it inside the Node worker thread:

```ts
const url = `data:text/javascript;base64,${Buffer.from(descriptor.workerSource).toString("base64")}`;
const mod: unknown = await import(url);
```

V8 uses the import URL as the script name, so every stack frame from code in that module renders as `at fn (data:text/javascript;base64,<entire bundle>:line:col)`. A 6-frame throw from the fetch plugin ≈ 3.5 MB of stack text. The stack is captured verbatim by `serializeLifecycleError` / `serializeCallableEnvelopeError` (`packages/sandbox/src/plugin.ts`) onto `system.error` / `action.error` events; `GuestSafeError` propagation re-enters it on `action.error`; `EventStore.record` stores it uncapped.

Error flow (bloat path in **bold**):

```
plugin worker code throws (Node worker thread)
  │  V8 stack: frame filename = **entire data: URL**
  ▼
pluginRequest catch / envelope path (plugin.ts)
  │  serializeLifecycleError / serializeCallableEnvelopeError — stack verbatim
  ▼
system.error / action.error event ──► EventStore.record ──► **multi-MB row**
```

## Goals / Non-Goals

**Goals:**

- Plugin worker modules have a short, meaningful script name in stack traces: `sandbox-plugin:<name>`.
- Stack frames stay debuggable: function names and bundle-relative `line:col` preserved.
- Recorded `system.error` / `action.error` payloads for host-plugin failures are KB-scale, with a durable spec contract preventing regression.
- No change to the import mechanism's security posture (no filesystem resolution, no loader hooks, same inert-string evaluation).

**Non-Goals:**

- EventStore payload-size cap (`error`/`output`/`input`/`meta`). Deliberately deferred — candidate follow-up change; this design fixes the only known megabyte source at its origin.
- Capture-time stack sanitization (regex-stripping `data:` frames in the serializers). Superseded by fixing the name at the source.
- Source-map translation to original TypeScript files/lines.
- Changing `import.meta.url` / module-cache identity (see Risks).
- The build-time metadata import in `packages/sandbox/src/vite/sandbox-plugins.ts` (same `data:` pattern, build-time only; its errors never reach the EventStore).

## Decisions

### D1: `//# sourceURL` magic comment, not loader hooks or temp files

Append to the source before building the `data:` URL:

```ts
const source = `${descriptor.workerSource}\n//# sourceURL=sandbox-plugin:${descriptor.name}`;
```

`//# sourceURL` is a V8-level convention (same family as `sourceMappingURL`): when present as the last line of a script, V8 uses it as the script's display name in `Error.stack`. Verified on Node 24: a throw from a data:-imported module renders `at Module.boom (sandbox-plugin:fetch.mjs:1:39)` — no blob, line:col intact. Vite/rollup are uninvolved; the append happens after build, so no minifier can strip it.

Alternatives considered:

- **`module.registerHooks()` (Node ≥22.15) per-thread sync hooks** serving `sandbox-plugin:<name>` from an in-thread Map. Gives true short module identity (`import.meta.url`, module-cache key) by construction — but adds module-system machinery, intercepts every import in the sandbox worker thread, and the API is release-candidate stability. The actual defect (stack display) doesn't need it. Documented upgrade path if the `import.meta.url` side channel ever bites.
- **`module.register()` off-thread hooks**: process-wide interception plus MessagePort plumbing to sync dynamically-arriving bundles to the hooks thread, with an import-before-registered race. Most invasive; rejected.
- **Temp-file import** (`mkdtemp` + `file://`): real filenames, but introduces disk writes per worker spawn, cleanup lifecycle, and an on-disk executable artifact the current inert-string posture deliberately avoids.

### D2: Inject in the loader at runtime, not the vite transform at build time

`loadPluginFromSource` already has `descriptor.name`, and is the single choke point every descriptor passes through regardless of origin (vite transform, tests, future producers). Baking the comment into `workerSource` at build time would cover only vite-produced bundles and duplicate the name into the emitted string.

### D3: Virtual name format `sandbox-plugin:<name>`

Matches the `?sandbox-plugin` transform terminology and the descriptor's `name` field (engine-controlled, simple identifiers). No `.mjs` suffix — it's not a resolvable path, and the bare scheme form is what `registerHooks` would use if we ever upgrade (D1 alternative), keeping the spec contract stable across that migration.

### D4: Positive module-identity contract, negative regression corollary

The spec requirement is stated positively — frames from a plugin's worker module SHALL identify the plugin as `sandbox-plugin:<name>:<line>:<col>` — because the defect is wrong module identity, not "events too big" (the EventStore overflow was the detection vector). The corollary — serialized error payloads SHALL NOT contain `data:text/javascript` — is the regression guard, mirroring the existing guest-facing opacity contract (`actions` spec: bridge-collapsed stacks contain no `/var/`, `node_modules`, `data:text/javascript`).

### D5: Leading `\n` before the comment

V8 honors `sourceURL` only at the end of the script; the appended newline guarantees the comment is the final line even if a bundle ends in a `//` line comment. Bundles are ESM (semicolon/newline-tolerant), so the append cannot change program behavior.

## Risks / Trade-offs

- **[`import.meta.url` remains the giant data: URL]** sourceURL changes stack display only; module-cache key and `import.meta.url` keep the blob. If a bundled dep ever embeds `import.meta.url` in an error message or log, the blob leaks through a path this fix doesn't cover. → Status quo today (no bundled dep observed doing this); the SHALL-NOT-contain-`data:text/javascript` event-payload contract turns any future leak into a test failure; `registerHooks()` is the documented contained upgrade.
- **[Line numbers are bundle-relative, not original-source]** `sandbox-plugin:fetch:1361` points into the rollup bundle, not `sandbox-stdlib/src/fetch/...`. → Bundles are unminified, so function names read straight off the stack; inline source maps + `--enable-source-maps` would roughly double `workerSource` (structured-cloned into every worker spawn) and add a process-wide flag — not worth it unless a real debugging session proves otherwise.
- **[Custom `Error.prepareStackTrace` bypasses sourceURL]** Discovered during implementation: any installed `prepareStackTrace` that formats via `CallSite.getFileName()` (vitest's source-map remapper does) reports the raw data: URL, not the sourceURL name. → Production workers run plain Node with V8's default formatter (honors sourceURL; verified). Unit tests clear the override for the first lazy `.stack` access to assert the production shape; the dev probe verifies the real runtime end-to-end. If the runtime ever adopts `--enable-source-maps` or a stack-rewriting dep, the no-`data:text/javascript` event-payload contract test fails loudly.
- **[Name collision across plugins]** Two descriptors with the same `name` would share a display name (not a module identity — the data: URLs still differ). → Plugin names are engine-controlled and already unique per sandbox (topo-sorted dependency graph keyed by name).
- **[Existing fat rows on staging]** This fix bounds new rows only. → Time-based retention (1-day window) ages the old rows out without intervention; DuckDB memory capping is the other workspace's fix.

## Migration Plan

Pure runtime behavior change in the engine; no manifest, SDK, persistence, or tenant-facing format changes. Deploys with the normal image rotation; no tenant rebuild/re-upload required (no `docs/upgrades.md` entry needed). Rollback = revert the commit.

## Open Questions

None — design settled in the pre-proposal interview (mechanism, injection site, name format, contract shape, deferred cap all user-confirmed).
