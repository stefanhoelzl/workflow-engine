## Context

`openspec/specs/` has 60 live capability directories accumulated across 106 archived changes over ~3 weeks. Incremental change-by-change archival has produced three kinds of debt:

1. **Tombstones** — two directories (`compose-stack`, `pulumi-stack`) contain only an HTML comment stating they were replaced by a successor. The successors themselves have since been replaced or archived; the tombstones are now pointers-to-nothing.
2. **Archive-era artifacts** — when `sandbox-plugin-architecture` was archived, six plugin-named capability directories (`sandbox-plugin`, `sandbox-stdlib`, `sandbox-sdk-plugin`, `sandbox-host-call-action-plugin`, `sandbox-trigger-plugin`, `wpt-compliance-harness-plugin`) were created with `TBD - update Purpose after archive` placeholders and never filled in. Four of them contain only 1-3 requirements duplicating material that logically belongs in a parent capability.
3. **Dead code in live specs** — `sandbox/spec.md` (1675 lines, 68 requirements) still carries requirements describing a pre-plugin-architecture boundary: the `sandbox(source, methods, options)` signature, `__hostCallAction`/`__emitEvent`/`__dispatchAction` host bridges, runtime source-appending shims, and guest-supplied output schema validation. The `sandbox-plugin-architecture` + `sandbox-output-validation` changes removed all of those, replacing them with a plugin composition model whose real mechanism is split across the `sandbox-stdlib`, runtime `plugins/`, and SDK `sdk-support` modules. Additionally, every "Safe globals — X" requirement in `sandbox/spec.md` (~25 of them) describes a guest-visible global that is actually installed by a plugin in `sandbox-stdlib`, not by the sandbox core.

Six specs have accumulated beyond the build pipeline's needs: `build`, `build-system`, `build-time-typecheck`, `vite-build`, `vite-plugin`, `workflow-build` collectively describe ~300 lines of overlapping material from different archive-era angles. The net result is that a reader of `build/spec.md` encounters event-bus-driven action composition wording that has not matched the code since direct-call action composition landed.

Finally, `openspec validate --specs --strict` reports 18 failing specs today, mostly due to missing `## Purpose` sections. Eight of those eighteen are specs this change already deletes or absorbs; fixing the remaining ten with trivial Purpose paragraphs is free effort while we are in the tree.

This change is the first of three. `cleanup-specs-content` and `cleanup-specs-infrastructure` follow it and reconcile real content (`runtime-config`, `auth`, `trigger-ui`, `dashboard-list-view`, `executor`, `sdk`, `http-trigger`, `action-upload`, `cli`, `ci-workflow`, `infrastructure`) against the code. Both follow-ons are drafted against the post-structure capability layout and cannot apply before this change lands.

## Goals / Non-Goals

**Goals**

- Delete, fold, or reshape every structurally-broken spec so the spec directory reflects the code's actual module layout.
- Move every plugin-installed guest-visible global out of `sandbox/spec.md` into `sandbox-stdlib/spec.md`, grouped by owning plugin (web-platform / fetch / timers / console).
- Move the dead `Action call host wiring` requirement out of `sandbox/spec.md` and replace its real mechanism with content in `sdk` + `actions`.
- Document the Phase-1 quickjs-wasi extension globals in `sandbox/spec.md` as the VM-level baseline (currently undocumented anywhere).
- Bring `openspec validate --specs --strict` from 18 failures to ≤1 after this change applies.
- Introduce symmetric `runtime-build` + `workflow-build` capabilities that match the two real build outputs in the monorepo.

**Non-Goals**

- No content-level reconciliation of requirements that are kept in place. A spec that keeps its identity and has no requirement whose body is contradicted by this change's moves is left untouched. The follow-on content proposals handle rot like `WORKFLOW_DIR` references, the `X-Auth-Request-*` claim in `trigger-ui`, the `image_tag` vs `image_digest` discrepancy in `infrastructure`, and the ~3200-line reconciliation work estimate documented in the interview log.
- No code changes. This is a spec-content-only change.
- No renames of capabilities that are keeping their role (e.g. `actions` is not renamed to `actions-plugin` or vice-versa). Renames trigger reference churn in archived proposals that we explicitly accept breaking but don't want to amplify.
- No refactor of `SECURITY.md`. `SECURITY.md` references code component names (`__sdk.dispatchAction`, `createFetchPlugin`, `headerUserMiddleware`) not spec capability names; it is the scope of `cleanup-specs-content`.
- No `openspec/project.md` rewrite. If a stale capability reference appears there, it gets edited in-place; a rewrite is out of scope.

## Decisions

### Split the sandbox spec into a 4-zone model rather than a 2-zone one

The interview originally resolved "all safe-globals → sandbox-stdlib". Code exploration in explore-mode showed that the quickjs-wasi extensions installed at Phase 1 of `worker.ts` (`base64Extension`, `cryptoExtension`, `encodingExtension`, `headersExtension`, `structuredCloneExtension`, `urlExtension`) DO install guest-visible globals: `atob`, `btoa`, `TextEncoder`, `TextDecoder`, `Headers`, `URL`, `URLSearchParams`, native `crypto.getRandomValues`, native `crypto.subtle`, native `DOMException`. These are VM baseline capabilities that plugins build on — `crypto.subtle` and `DOMException` are both wrapped by `sandbox-stdlib`'s web-platform plugin at Phase 2.

Zone A (sandbox core mechanism), Zone B (plugin contract in `sandbox-plugin`), Zone C (stdlib plugin catalogue in `sandbox-stdlib`), Zone D (surfaces where native + wrapper coexist: `DOMException` and `crypto.subtle`) gives us a split where each requirement lives in exactly one place and Zone-D items are clearly documented as such.

Alternative considered: a flat "all guest-visible globals in `sandbox-stdlib`" split. Rejected because it would require `sandbox-stdlib` to document things the stdlib doesn't own — any reader asking "where does `URL` come from?" would have to chase into `sandbox` anyway, so we might as well document it honestly.

### Fold small plugin-capability specs into their semantic parents

`sandbox-sdk-plugin`, `sandbox-host-call-action-plugin`, `sandbox-trigger-plugin`, `sandbox-store`, `workflow-loading`, `wpt-compliance-harness-plugin` are each 1-6 requirements describing a runtime mechanism that exists to serve a user-facing capability. Per the project's own OpenSpec rules ("A spec with only one requirement should usually be a requirement in a parent spec"), these belong folded. The parent for each is determined by what the plugin serves: the sdk-support plugin IS the SDK's `action()` mechanism; the host-call-action plugin IS the runtime side of action dispatch; and so on.

Alternative considered: keep the plugin specs standalone and cross-reference from the parent. Rejected because the cross-reference pattern produced the current TBD-placeholder mess — readers have to chase across files to understand a single coherent surface.

### Delete tombstones outright rather than leave breadcrumbs

Archive-era tombstones (`compose-stack`, `pulumi-stack`) exist as empty spec directories containing only an HTML comment. The interview's explicit decision was to break archive-era references freely. `openspec validate` does not enforce live↔archive cross-references, so deletion is safe. Breadcrumbs add cognitive load without value.

### Defer spec-delta file writing to `/opsx:apply` rather than produce them in the proposal

OpenSpec's proposal phase lists `specs` as one of four artifacts, and `tasks.md` depends on `specs` being present. This change's scope touches ~20 capabilities with deletions, folds, ADDED requirements, MODIFIED requirements, and REMOVED requirements. Producing those delta files exhaustively in the proposal would balloon proposal size to thousands of lines before implementation review; instead the tasks list enumerates exactly which delta files must be written and what they must contain, so implementation is a mechanical exercise in applying the design to the spec directory.

Alternative considered: produce skeletal delta files in the proposal (file exists, requirement headings present, bodies empty). Rejected because the skeleton would itself need review and would create the illusion that the proposal is further along than it is.

### Sequence the three proposals rather than bundle

The interview concluded with "one bundled proposal". Explore-mode's thread 2 quantified the reconciliation work at 27-32 hours; thread 5 noted that one 30-delta proposal is practically unreviewable in a sitting. Splitting into a structural pass (this change, ~4-6h), a runtime-facing content pass, and an infrastructure pass produces three reviewable units that land incrementally and never hold each other up. Proposals 2 and 3 are order-independent once this one applies.

Alternative considered: one monolithic `cleanup-specs`. Rejected because review risk and merge-conflict surface scale super-linearly with delta count.

## Risks / Trade-offs

- **[Risk] Deleting `compose-stack` / `pulumi-stack` breaks archived-proposal references** → Accepted explicitly per interview. `openspec validate` does not enforce archive refs; the archive is historical.
- **[Risk] Moving ~25 "Safe globals — X" requirements from `sandbox` to `sandbox-stdlib` could accidentally lose detail at archive time if MODIFIED is used incorrectly** → Mitigated by using REMOVED + ADDED rather than MODIFIED across capabilities; the requirement moves between spec files with its content intact, and the MODIFIED-workflow pitfall ("partial content loses detail at archive time") does not apply to cross-file moves.
- **[Risk] `workflow-build` rework absorbs content from four deleted capabilities — if any requirement is accidentally dropped, build-pipeline semantics lose their spec contract** → Mitigated by the tasks list enumerating each source-spec requirement and its destination; an explicit task exercise is "compare absorbed requirements against the deleted spec files to confirm nothing is lost".
- **[Risk] Follow-on proposals drift against this one's output** → Mitigated by having this change land first; proposals 2 and 3 apply against the post-structure state, not concurrently.
- **[Trade-off] The `sandbox` spec retains Zone-D content (native `DOMException` + native `crypto.subtle`) that is semantically shared with `sandbox-stdlib`'s web-platform wrappers** → Acknowledged; both specs cross-reference each other with explicit "native shape / guest-visible shape" language. This is cleaner than an arbitrary single-owner pick.

## Migration Plan

This is a spec-only change. "Migration" means capability-name drift for any downstream tooling or documentation that references spec IDs.

1. Apply the change in-tree. `openspec validate --specs --strict` must pass (≤1 failure, and only on capabilities whose content rot is handled by the follow-on proposals).
2. Grep `SECURITY.md`, `CLAUDE.md`, and `openspec/project.md` for any deleted capability name (`compose-stack`, `pulumi-stack`, `build`, `build-system`, `build-time-typecheck`, `vite-build`, `vite-plugin`, `webhooks-status`, `sandbox-sdk-plugin`, `sandbox-host-call-action-plugin`, `sandbox-trigger-plugin`, `sandbox-store`, `workflow-loading`, `wpt-compliance-harness-plugin`) and fix references. Expected hits: few to none (these files reference code names, not spec capability names, in current form).
3. Archive the change via `openspec archive cleanup-specs-structure`. The archive operation copies each delta into the live specs tree; deletions zero out the capability directory, which the archive engine should tolerate.
4. Proceed with `cleanup-specs-content` and `cleanup-specs-infrastructure` in either order.

**Rollback**: `git revert` the archive commit. Spec deltas are text; no state lives outside the tree. Follow-on proposals that were drafted against the post-structure layout will need to be rebased or their deltas re-keyed to old capability names, which is cheap.

## Open Questions

- Does `openspec archive` cleanly handle a capability-directory deletion (REMOVED-all-requirements + directory removal)? Validated empirically at `/opsx:apply` time by archiving the first deletion locally before proceeding to the rest.
- Do archived-change spec-delta files reference deleted capability names in a way that triggers reader confusion? Only matters for human spelunking; `openspec validate` and `openspec list` both ignore archive refs.
- Should `runtime-build` absorb the `pnpm start` script requirement (which chains workflow build + runtime execution)? Leaning yes because `pnpm start`'s owner is the runtime entry point, but the tasks explicitly call this out as a decision to confirm while writing deltas.
