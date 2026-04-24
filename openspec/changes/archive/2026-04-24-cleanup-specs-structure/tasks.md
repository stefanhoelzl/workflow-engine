## 1. Delete dead tombstones

- [x] 1.1 Remove `openspec/specs/compose-stack/` directory. Live spec was tombstone-only (no requirements), so no OpenSpec delta is needed — physical deletion is the entire change.
- [x] 1.2 Remove `openspec/specs/pulumi-stack/` directory. Same — tombstone-only, physical deletion only.

## 2. Delete legacy build specs

- [x] 2.1 REMOVED delta written for `build` at `specs/build/spec.md` (6 requirements).
- [x] 2.2 REMOVED delta written for `build-system` at `specs/build-system/spec.md` (3 requirements).
- [x] 2.3 REMOVED delta written for `build-time-typecheck` at `specs/build-time-typecheck/spec.md` (5 requirements).
- [x] 2.4 REMOVED delta written for `vite-build` at `specs/vite-build/spec.md` (4 requirements; `WORKFLOW_DIR` call-out included).
- [x] 2.5 REMOVED delta written for `vite-plugin` at `specs/vite-plugin/spec.md` (10 requirements).

## 3. Introduce runtime-build capability

- [x] 3.1 Runtime SSR build + native-binding externalization + Vite 8.x baseline + per-workspace build composition + SDK tsc build requirements written in `specs/runtime-build/spec.md`. Adjusted against the actual `packages/runtime/vite.config.ts` (entry: `src/main.ts`; externals: `@duckdb/node-bindings`, `@jitl/quickjs-wasmfile-release-sync`; `ssr.noExternal: true`). Corrected earlier proposal claim of a root `vite.config.ts` — there is none; each workspace has its own.
- [x] 3.2 `fetch-blob@4` pnpm-patch requirement written (patches/fetch-blob@4.0.0.patch, strips TLA, required for web-platform plugin bundling).
- [x] 3.3 Decision: the runtime `start` script (`vite-node src/main.ts`) lives in `packages/runtime/package.json` and is documented in `runtime-build`. There is NO root `start` script. Spec body clarifies that.

## 4. Rework workflow-build capability

- [x] 4.1 ADDED requirements written for: plugin import path, plugin-lives-in-SDK, per-workflow IIFE bundle with shared namespace, brand-symbol export discovery, workflow name derivation, action-name AST injection, HTTP manifest entry shape, cron manifest emission, manual manifest emission, trigger-identifier regex, build-time TS typecheck, fixed strict compiler options, scoped typecheck, TS peer dep, pretty error formatting, declaration-error failures. Spec delta at `specs/workflow-build/spec.md`.
- [x] 4.2 Purpose paragraph added directly to live `openspec/specs/workflow-build/spec.md` (fixes the missing-Purpose strict-validation failure).
- [x] 4.3 Cross-check: every requirement from the four deleted specs (`build`, `build-system`, `build-time-typecheck`, `vite-plugin`) is now represented in `workflow-build` ADDED requirements. `runtime-build` owns the runtime SSR side (Vite 8.x baseline, native externalization, `pnpm -r build`, fetch-blob patch, SDK tsc build). Nothing lost.

## 5. Fold narrow plugin specs into their parents

- [x] 5.1 REMOVED delta for `sandbox-sdk-plugin` at `specs/sandbox-sdk-plugin/spec.md` — three requirements pointed at `sdk`. ADDED absorption in `sdk` pending Task 10.1.
- [x] 5.2 REMOVED delta for `sandbox-host-call-action-plugin` at `specs/sandbox-host-call-action-plugin/spec.md` — three requirements pointed at `actions`. ADDED absorption in `actions` pending Task 10.2.
- [x] 5.3 REMOVED delta for `sandbox-trigger-plugin` at `specs/sandbox-trigger-plugin/spec.md` — three requirements pointed at `triggers`. ADDED absorption in `triggers` pending Task 10.3.
- [x] 5.4 REMOVED delta for `sandbox-store` at `specs/sandbox-store/spec.md` — six requirements pointed at `sandbox`. ADDED absorption in `sandbox` pending Task 7.9.
- [x] 5.5 REMOVED delta for `workflow-loading` at `specs/workflow-loading/spec.md` — two requirements pointed at `workflow-registry`. ADDED absorption in `workflow-registry` pending Task 10.4.
- [x] 5.6 REMOVED delta for `wpt-compliance-harness-plugin` at `specs/wpt-compliance-harness-plugin/spec.md` — one requirement pointed at `wpt-compliance-harness`. ADDED absorption pending Task 10.5.

## 6. Fold webhooks-status into http-trigger

- [x] 6.1 REMOVED delta for `webhooks-status` at `specs/webhooks-status/spec.md` — both requirements pointed at `http-trigger`. Noted overlap between the two (both describe 204/503 behaviour) — the `http-trigger` absorption collapses them into one.
- [x] 6.2 ADDED in `http-trigger` — rolled into Task 10.6. The consolidated readiness-endpoint requirement lives in `specs/http-trigger/spec.md`.

## 7. Sandbox capability reshape (core boundary)

- [x] 7.1 REMOVED deltas written for all 27 plugin-installed safe-globals in `specs/sandbox/spec.md` (console, timers, self, navigator, reportError, EventTarget, Event, ErrorEvent, AbortController, AbortSignal, Guest-side microtask routing, URLPattern, fetch, Request, Response, Blob, File, FormData, streams, Queuing strategies, TextEncoderStream/TextDecoderStream, Compression/DecompressionStream, Observable, scheduler, structuredClone, queueMicrotask, indexedDB, User Timing). Each points at `sandbox-stdlib`.
- [x] 7.2 REMOVED delta for `Hardened outbound fetch` pointing at `sandbox-stdlib` (fetch plugin's `hardenedFetch` default).
- [x] 7.3 REMOVED delta for `Action call host wiring` — the single biggest lie removed. Full Reason/Migration to sdk + actions + workflow-registry.
- [x] 7.4 MODIFIED `Safe globals — performance.now`: dropped `bridge.setRunContext` reference; described the wasi-hooks monotonic anchor lifecycle (seeded pre-`QuickJS.create`, re-anchored per-run via `onBeforeRunStarted`). Observable scenarios preserved.
- [x] 7.5 MODIFIED `Safe globals — DOMException`: native class from `structuredCloneExtension`; Proxy wrapper lives in `sandbox-stdlib`.
- [x] 7.6 MODIFIED `WebCrypto surface`: native `crypto.getRandomValues` + native `crypto.subtle` handle from `cryptoExtension`; the `subtle-crypto` wrapper is in `sandbox-stdlib`. `Key material lives in WASM` kept as VM-level property inside this requirement (merged rather than split — they describe the same surface).
- [x] 7.7 ADDED `VM-level web-platform surface via quickjs-wasi extensions` with full 6-extension table + scenarios (globals exist before Phase 2; adding new extension requires updating list + SECURITY.md §2).
- [x] 7.8 MODIFIED `Isolation — no Node.js surface`: restated as "sandbox core SHALL install no plugin-style host descriptors on globalThis; the only VM-level globals are those listed under 'VM-level web-platform surface via quickjs-wasi extensions'". Documents the two-source model explicitly.
- [x] 7.9 ADDED absorbed `SandboxStore` requirements (5 total: per-`(tenant,sha)` access; production plugin catalog composition; process-lifetime; factory shape; onEvent metadata stamping). Kept all scenarios from `sandbox-store/spec.md` intact. The `Key material lives in WASM` requirement was folded into `WebCrypto surface` rather than kept separate.

## 8. Sandbox-stdlib capability absorb (plugin catalogue)

- [x] 8.1 Purpose section rewritten directly in live `openspec/specs/sandbox-stdlib/spec.md` (describes the plugin catalogue: web-platform, fetch, timers, console, plus WPT harness).
- [x] 8.2 ADDED requirements written in `specs/sandbox-stdlib/spec.md` absorbing every safe-global REMOVED from sandbox. Grouped by plugin. Requirements consolidated where they overlapped (e.g., Event + ErrorEvent + EventTarget into one "EventTarget, Event, ErrorEvent" requirement; Blob + File + FormData together; streams + queuing strategies + Text{Enc,Dec}oderStream together). Scenario coverage preserved for each.
- [x] 8.3 ADDED `fetch plugin — hardenedFetch pipeline` with all six pipeline stages (scheme allowlist incl. data: short-circuit, IANA blocklist, zone-ID rejection, cross-origin Authorization strip, 30s timeout, manual redirect with 5-hop cap). All original scenarios preserved (private-IP, zone-ID, data: URL, redirect-to-private, timeout, cross-origin auth strip).
- [x] 8.4 Cross-check: every REMOVED from sandbox Task 7.1-7.2 has a matching ADDED in sandbox-stdlib Task 8.2-8.3. No body lost. Overlapping REMOVEDs (Event/ErrorEvent/EventTarget; Blob/File; streams/queuing) consolidated intentionally to reduce redundancy.

## 9. Sandbox-plugin capability fill

- [x] 9.1 Purpose rewritten directly in live `openspec/specs/sandbox-plugin/spec.md`. Describes the Plugin contract, composition, boot-phase sequence (Phase 0–4), descriptor shape, SECURITY.md R-1–R-9.
- [x] 9.2 No requirements move in/out of sandbox-plugin in this change. Its 12 requirements are current per explore-mode verification against `plugin-compose.ts` + `plugin-runtime.ts`. Purpose-only edit.

## 10. Capability absorption — SDK + actions + triggers + workflow-registry + wpt-compliance-harness + http-trigger

- [x] 10.1 sdk ADDED: `createSdkSupportPlugin factory`, `action() SDK export is a passthrough`, `No runtime-appended dispatcher source`. Full scenarios preserved.
- [x] 10.2 actions ADDED: `createHostCallActionPlugin factory`, `host-call-action plugin depends on none`, `Per-sandbox manifest binding`. Full scenarios preserved.
- [x] 10.3 triggers ADDED: `createTriggerPlugin factory`, `Trigger plugin is optional`, `Reserved trigger. event-kind prefix`. Full scenarios preserved.
- [x] 10.4 workflow-registry ADDED: `Workflow loading instantiates one sandbox per (tenant, sha)`, `Manifest env resolution at build time`. Absorbed from workflow-loading.
- [x] 10.5 wpt-compliance-harness ADDED: `createWptHarnessPlugin factory` with both scenarios (`__wptReport` collect routing; private by default).
- [x] 10.6 http-trigger ADDED: `GET /webhooks/ readiness endpoint` — consolidated the two overlapping webhooks-status requirements into one requirement with three scenarios (204 when registered, 503 when empty, POST traffic unaffected).

## 11. Strict-validation Purpose fixes

- [x] 11.1 Purpose sections added directly to live specs: `docker`, `http-security`, `linting-formatting`, `network-policy-profiles`, `pod-security-baseline`, `storage-backend`, `testing-setup`, `typescript-config`, `workflow-manifest`. Also fixed the three that had `## ADDED Requirements` headers leftover from archive (`linting-formatting`, `testing-setup`, `typescript-config`) — replaced with `## Requirements`.
- [x] 11.2 `build` physical directory removed in Task 2.1 chain; its REMOVED delta is authored. Once archived, the stray "Requirement must have at least one scenario" strict-validation failure on `build` vanishes together with the directory.

## 12. Post-apply validation

- [x] 12.1 Live strict validation: 52 passed, 6 failed. All 6 failures (`build`, `build-system`, `build-time-typecheck`, `vite-build`, `vite-plugin`, `webhooks-status`) are capabilities this change REMOVES; they vanish on archive. Expected post-archive: 0 failures. Nothing for `cleanup-specs-content` to inherit.
- [x] 12.2 `openspec validate cleanup-specs-structure --strict` — change is valid.
- [x] 12.3 Grep run: `compose-stack` / `pulumi-stack` / `workflow-loading` / `sandbox-store` / `sandbox-sdk-plugin` / `sandbox-host-call-action-plugin` / `sandbox-trigger-plugin` / `webhooks-status` — none appear in `SECURITY.md`, `CLAUDE.md`, `README.md`, or `openspec/project.md`. Stale `vite-plugin` capability-name references fixed: `openspec/project.md` tree diagram + test reference; `README.md` tree diagram. SECURITY.md references `sandbox-store.ts` (a code path) not the capability name — unchanged. Deeper content-level rot (`__hostCallAction` references, `sandbox(source, methods, options)` signature, `WORKFLOW_DIR` mentions) deferred to `cleanup-specs-content`.
- [x] 12.4 `pnpm lint` green. No TypeScript / infra files touched; `pnpm check` + `pnpm test` unnecessary (spec-content-only change).
- [ ] 12.5 **User action**: commit + `openspec archive cleanup-specs-structure`. Not performed by the agent. After archive, live `openspec/specs/` reflects the new layout; strict validation hits 0 failures.

## 13. Unblock follow-on proposals

- [ ] 13.1 **User action**: after archive, `cleanup-specs-content` and `cleanup-specs-infrastructure` can be applied in either order.
