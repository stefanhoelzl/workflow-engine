## 1. Production sandbox additions

- [x] 1.1 Add `TRIVIAL_SHIMS` source constant in `packages/sandbox/src/globals.ts` installing `globalThis.self = globalThis` and `globalThis.navigator = Object.freeze({ userAgent: \`WorkflowEngine/${VERSION}\` })`
- [x] 1.2 Add `REPORT_ERROR_SHIM` source constant in `packages/sandbox/src/globals.ts` with the guest-side serializer that calls `__reportError`
- [x] 1.3 Wire `__reportError` installation in `packages/sandbox/src/worker.ts` at VM init: install from construction-time `methods` with per-run `extraMethods` override precedence
- [x] 1.4 Evaluate `TRIVIAL_SHIMS` and `REPORT_ERROR_SHIM` in `worker.ts` init sequence, after WASM extensions load, before the IIFE source eval
- [x] 1.5 Extend `RESERVED_BUILTIN_GLOBALS` in `packages/sandbox/src/index.ts` to include `self`, `navigator`, `reportError`, `__reportError`
- [x] 1.6 Add sandbox unit tests verifying `self === globalThis`, `navigator.userAgent` matches the package version, `navigator` is frozen, `reportError(new Error(...))` payload shape reaches a test-injected `__reportError`
- [x] 1.7 Add sandbox security test verifying per-run `extraMethods.__reportError` overrides construction-time `methods.__reportError` for the scope of that run
- [x] 1.8 Add sandbox security test verifying `__reportError` is absent (throws `ReferenceError` when called) in a sandbox constructed without it

## 2. SECURITY.md + CLAUDE.md + convention docs

- [x] 2.1 Amend `SECURITY.md` §2 NEVER wording per design.md D10 (add "without extending the §2 allowlist in the same PR" qualifier; add explicit allowlist-is-authoritative statement)
- [x] 2.2 Add allowlist entries for `globalThis.self`, `globalThis.navigator`, `globalThis.reportError`, `__reportError` in `SECURITY.md` §2 with shim / capability / rationale rows
- [x] 2.3 Update `CLAUDE.md` Security Invariants bullet "NEVER add a global, host-bridge API..." to match the revised SECURITY.md §2 wording

## 3. Vendor script (scripts/wpt-refresh.ts)

- [x] 3.1 Create `scripts/wpt-refresh.ts` skeleton (tsx-runnable, tsx CLI args parser for `--sha`, `--strict`)
- [x] 3.2 Implement git clone step: shell out to `git clone --depth 1 --branch <ref>` into a temp dir under `/tmp/wpt-refresh-<timestamp>/`, with `--sha` performing a regular clone + `git checkout <sha>`
- [x] 3.3 Implement file enumeration: walk tree, match `*.any.js`, `*.any.https.js`, `*.worker.js`, `*.worker.https.js` suffixes
- [x] 3.4 Implement META parser: regex-based extraction of `// META: <key>=<value>` directives, supports `global`, `script`, `timeout`, `title`, `variant`
- [x] 3.5 Implement worker-scope filter: applicable iff `global=` directive lists any of `worker`, `dedicatedworker`, `sharedworker`, `serviceworker`, `shadowrealm`, OR absent
- [x] 3.6 Implement script-dependency BFS walk: resolve `META: script=` paths (absolute from WPT root or relative to file), transitively gather all referenced scripts
- [x] 3.7 Implement `.sub.js` template substitution: fixed substitutions `{{host}} → web-platform.test`, `{{ports[http][0]}} → 8000`, etc.; applied at vendor time
- [x] 3.8 Implement `{{host}}/{{ports}}` scan on transitive deps to detect network-dependent tests; those become `skip: { reason: "contains {{…}} network dependency" }` in manifest
- [x] 3.9 Implement spec.ts classification: import spec synchronously (tsx supports), apply `findMostSpecific` to each applicable file path
- [x] 3.10 Implement vendor copy: for pass-classified files only, copy file + transitive deps + `resources/testharness.js` to `packages/sandbox/test/wpt/vendor/` preserving relative paths
- [x] 3.11 Implement manifest emit: write `vendor/manifest.json` with `{ wptSha, vendoredAt, tests: {...} }` structure per design §7
- [x] 3.12 Implement `--strict` mode: after full run, validate that every `file:subtest` key in spec.ts references a file still present in the vendor/manifest; exit non-zero on mismatches with a clear message
- [x] 3.13 Register `test:wpt:refresh` script in the root `package.json`

## 4. Harness utilities

- [x] 4.1 Implement `packages/sandbox/test/wpt/harness/match.ts` exporting `specificity(pattern)` and `findMostSpecific(spec, key)` per design §D3 (count-non-wildcard-chars + subtest boost + severity tiebreak); include a glob-match helper compatible with picomatch or minimatch
- [x] 4.2 Implement `packages/sandbox/test/wpt/harness/limited-all.ts` exporting `limitedAll(tasks, concurrency)` — worker-pool-style concurrency cap over an array of async factories
- [x] 4.3 Implement `packages/sandbox/test/wpt/harness/preamble.ts` exporting a source string containing the testharness bootstrap: `self`-stub reassurance, `location` stub, `add_completion_callback` + `add_result_callback` wiring that invokes `__wptReport(name, status, message)` per subtest and resolves the `__wptEntry` promise
- [x] 4.4 Implement `packages/sandbox/test/wpt/harness/composer.ts` exporting `compose({ preamble, testharness, deps, file })` that concatenates the sources in the correct evaluation order, wrapping the last two in a function that assigns to `globalThis.__wptEntry`
- [x] 4.5 Implement `packages/sandbox/test/wpt/harness/runner.ts` exporting `runWpt(path, entry)` with: source composition, sandbox construction with `memoryLimit: 128MB`, per-run `extraMethods.__wptReport` captured into a results array, external watchdog (10s default / 45s long), mandatory `try { … } finally { clearTimeout; sb?.dispose() }`
- [x] 4.6 Add harness unit tests verifying `findMostSpecific` on the specificity + severity test matrix from design §D3

## 5. spec.ts baseline

- [x] 5.1 Create `packages/sandbox/test/wpt/spec.ts` with the `Expectation` type and the `spec` constant populated per design §6
- [x] 5.2 Include the `"**"` catchall with reason "not yet classified"
- [x] 5.3 Include Tier-1 pass entries (encoding, url, timers, structured-clone, atob, WebCryptoAPI)
- [x] 5.4 Include missing-polyfill skips (microtask-queuing, dom/abort, dom/events, fetch/api, streams, FileAPI, xhr/formdata, compression, encoding/streams, DOMException, urlpattern, FileReader)
- [x] 5.5 Include structural skips (idlharness, fetch/api/cors, credentials, integrity, policies, FormData <form> ctor)
- [x] 5.6 Include known subtest-level skips (e.g., WebCryptoAPI JWK export)

## 6. Vitest runner (wpt.test.ts)

- [x] 6.1 Create `packages/sandbox/test/wpt/wpt.test.ts` using the top-level-await pattern per design §D6 + §8
- [x] 6.2 Partition manifest entries into runnable and skipped lists
- [x] 6.3 `await limitedAll(runnable.map(task), Math.max(4, availableParallelism() * 2))` with `WPT_CONCURRENCY` env override
- [x] 6.4 Synchronously register `describe.skip(path, …, { reason })` for skipped entries
- [x] 6.5 For runnables: `describe(path)` + `it(subtest)` per observed subtest; `it.skip` for entries in `skippedSubtests` or spec.ts `:subtest` overrides
- [x] 6.6 Register synthetic failing `it()` per declared skip whose name was never observed (drift detection)
- [x] 6.7 Create `packages/sandbox/test/wpt/vitest.config.ts` if needed (or extend `packages/sandbox/vitest.config.ts`) so the WPT suite lives outside the default `pnpm test` discovery
- [x] 6.8 Register `test:wpt` script in the root `package.json`
- [x] 6.9 Add unit test for `limitedAll` — verify concurrency cap, ordering of resolved results

## 7. First-run vendoring + baseline

- [x] 7.1 Run `pnpm test:wpt:refresh` without `--sha` to pick up latest WPT main; commit the resulting `packages/sandbox/test/wpt/vendor/` tree
- [x] 7.2 Run `pnpm test:wpt` and iterate on spec.ts skip entries until the suite exits zero (every non-skipped subtest passes)
- [x] 7.3 For any unexpected failures observed in the first run, triage: is this a real sandbox bug (add to backlog, fix before merge), or is this a polyfill gap (add a narrower skip entry to spec.ts with `needs X polyfill` reason)
- [x] 7.4 Verify the full suite completes in under 5 minutes on a developer machine (budget per design: 1–3 min realistic)

## 8. Documentation

- [x] 8.1 Add `packages/sandbox/test/wpt/README.md` documenting `pnpm test:wpt:refresh` flags, manifest invariants, spec.ts editing conventions, and drift-detection semantics
- [x] 8.2 Cross-reference the WPT suite from `SECURITY.md` §2 (test-only infrastructure; `__wptReport` explicitly not in production)
- [x] 8.3 Update `CLAUDE.md` commands section to mention `pnpm test:wpt` and `pnpm test:wpt:refresh` alongside the existing `pnpm test`

## 9. Cleanup

- [x] 9.1 Delete the `/spike/` directory (verification artifacts) once pattern lock-in is landed
- [x] 9.2 Verify `pnpm validate` passes (lint + typecheck + tests + tofu checks)
- [ ] 9.3 Update `openspec/project.md` if the project context description becomes stale after this change lands (e.g., mention WPT compliance measurement as a capability of the sandbox package)
