## Context

Manifest validation today splits across two unsynchronized tiers:

```
        BUILD-TIME (live SDK objects)              SERVER-SIDE (serialized JSON)
        packages/sdk/src/cli/build-workflows.ts    packages/core/src/index.ts
        ────────────────────────────               ──────────────────────────────

        - typeof handler === "function"            workflowManifestSchema
        - "is this a Zod schema" guards            ├── name regex (already present)
        - default-export-action ban                ├── cron schedule.min(1)+sentinel
        - at-most-one defineWorkflow per file      ├── tz IANA validation
        - trigger name regex   ◀── DUPLICATE ─────▶ │
        - cron schedule empty  ◀── DUPLICATE ─────▶ │
        - cron tz empty        ◀── DUPLICATE ─────▶ │
        - reserved http response headers           (no schema rule)
        - secretBindings extraction                secretBindings: z.never()
                                                    secrets/secretsKeyId pairing
```

The schema is already the canonical home for several rules; the build-time copies exist only to produce friendlier per-workflow messages and to fail before the upload POST. Three rules the schema *should* enforce are missing entirely (≥1 trigger, unique trigger names, unique action names), and one rule (reserved http response headers) lives only at build-time. The mismatch means hand-crafted manifests, future API clients, or any non-build caller bypass rules that are intuitively part of the manifest contract.

The interview that produced this proposal landed on a sharper architectural stance:

> The schema in `packages/core` is the **canonical** validation tier for every rule expressible on the serialized manifest. Build-time validation is reserved for rules that need live SDK objects (function refs, Zod instances, brand symbols).

This change operationalizes that stance: it adds the missing schema rules, deletes the build-time duplicates, migrates the one build-only rule into the schema, and introduces a shared formatter so author-facing error text stays uniform across both tiers.

## Goals / Non-Goals

**Goals:**

- Reject zero-trigger workflows at upload, with a clear single-line author-facing message.
- Make `workflowManifestSchema` the single source of truth for rules expressible on the serialized manifest.
- Preserve the existing single-line `Workflow "<name>": …` error format that authors see today for live-object rules.
- Preserve the documented 422 wire shape (`{ error, issues?: Array<{path, message}> }`) as a non-breaking superset by adding `formatted: string` per issue.
- Establish a small adapter (`formatIssue`) that both build-time and server-side use, so any future serializable rule added to the schema produces consistent output.

**Non-Goals:**

- Migrating live-object build-time checks (handler-must-be-function, Zod-schema guards, default-export-action ban, at-most-one-defineWorkflow) into the schema. They are intrinsically build-time and stay there.
- Replacing the existing 422 wire shape with a `string[]`-of-formatted-lines. The structured `{path, message}` form is preserved for non-CLI consumers.
- Cleaning up runtime code paths that now handle "impossible" inputs (e.g. the `for (const entry of workflow.triggers)` loop in `workflow-registry.ts:383` is still safe with the schema enforcing non-empty arrays). Per CLAUDE.md "don't add validation for scenarios that can't happen," no defensive assertions are added.
- Writing a generic Zod-issue-to-message library. `formatIssue` is scoped to the manifest's known collection shapes (`triggers[i]`, `actions[i]`), with a path-string fallback.

## Decisions

### Decision: Schema is the canonical tier; build-time runs `safeParse` and routes issues through `formatIssue`

`buildManifestFromMod` in `packages/sdk/src/cli/build-workflows.ts` runs `workflowManifestSchema.safeParse(built)` as a final pass. For every Zod issue, it calls `buildContext.error(formatIssue(issue, built))` — one error per issue, preserving the parallel-reporting style today's build uses.

**Alternative considered: keep duplicates in build-time for friendlier messages.** Rejected because it has produced exactly the divergence we are fixing (rules drift; non-build callers bypass them; the schema and the build disagree about what's valid). The friendliness gap is closed by `formatIssue`.

**Alternative considered: do not run `safeParse` at build, only ensure the schema's rules trip on POST.** Rejected because authors should learn about a violation before the round-trip to the server, especially for offline or pre-CI use of `wfe build`.

### Decision: `formatIssue(issue, parsedValue)` lives in `packages/core` next to the schema

The formatter is exported alongside `ManifestSchema`. Both the SDK build and the runtime upload handler import it. Co-locating with the schema is consistent with the canonical-tier framing — the schema's renderer belongs with the schema.

**Alternative considered: SDK-only formatter.** Rejected because the runtime upload handler needs the same rendering and importing SDK from runtime crosses a package boundary the codebase deliberately does not cross.

### Decision: 422 wire shape is augmented (non-breaking), not replaced

Each entry in the existing `issues: Array<{ path, message }>` array gains a third field `formatted: string`. The CLI prints `formatted` directly; structured consumers continue to see `{path, message}`.

**Alternative considered: replace `issues` with `string[]`.** Rejected because `action-upload/spec.md` line 13 documents the structured shape and changing it would break any non-CLI consumer that parses the existing fields. The augmented form gets the same author-facing UX without the breakage.

### Decision: Full-context message format, e.g. `Workflow "demo": cron trigger "everyFiveMinutes": schedule must be non-empty`

`formatIssue` walks `issue.path`. For path[0] === `"triggers"` (or `"actions"`), it peeks at `parsedValue.triggers[i].type` and `.name` to render `<type> trigger "<name>"`. For leaves outside known collections, it falls back to a path-string like `triggers[2].request.headers.properties.x-internal`.

**Alternative considered: minimal `triggers[1].schedule: …` form.** Rejected because the existing build messages already render the kind and name (`cron trigger "X" has no schedule`); a regression on context would degrade authoring UX.

**Alternative considered: aggregating Zod's pretty-printer output.** Rejected because today's build emits one line per problem; a multi-line aggregated dump conflicts with that convention.

### Decision: Schema-author message convention — write the SUFFIX only

When adding `{error: "…"}` on a leaf rule (e.g. `z.string().min(1, {error: "must be non-empty"})`), authors write the suffix only. `formatIssue` supplies the prefix. This keeps schema messages composable and unburdens schema authors from worrying about the path-walk's output.

### Decision: Unique-name rules are net-new, not migrations

Today the JS module's export-name uniqueness implicitly guarantees unique trigger/action names per workflow. The schema adds explicit `.refine`s on the workflow object (`new Set(w.triggers.map(t => t.name)).size === w.triggers.length`, same for actions). This catches hand-crafted manifests that bypass the build entirely. Marked as ADDED requirements rather than MODIFIED in `workflow-manifest`.

## Risks / Trade-offs

- **Pre-existing zero-trigger or otherwise non-conforming workflows in production.** These keep running until the next upload, which then fails. → Mitigation: documented as an upgrade note in `docs/upgrades.md`. Operators audit and re-upload affected workflows. Likelihood is low (zero-trigger workflows have no observable behavior).

- **Test churn.** Many existing tests in `build-workflows.test.ts` assert on old build-time wording. Each such test must be updated to expect `formatIssue`-rendered text. → Mitigation: the message format is mechanical (single-line, fixed prefix template); test updates are predictable.

- **Build-time message wording user-visible delta.** Authors who have grown accustomed to specific old wordings will see new wordings for the migrated rules. → Mitigation: the new wordings are derivable from the old by substitution; no information is lost. Documented in the change notes.

- **`formatIssue` is a new code path touched by every upload.** A bug in path-walking could degrade error UX silently (e.g. fall back to path-string when full-context was expected). → Mitigation: dedicated unit tests in `packages/core` cover the path-walk for each known collection (`triggers[i]` of each type, `actions[i]`) and the fallback case.

- **Wire-shape augmentation invites consumer drift.** Adding `formatted: string` is non-breaking, but mixed shapes (some clients consume `formatted`, others `{path, message}`) can drift over time. → Mitigation: the change is small enough that the surface is tractable; documented in `action-upload/spec.md` so it's discoverable.

- **YAGNI on `formatIssue`'s collection awareness.** The formatter knows about `triggers[]` and `actions[]` discriminators today. Adding a new top-level collection to the manifest later means teaching the formatter. → Mitigation: this is a small, contained edit; flagged here so future changes don't miss it.
