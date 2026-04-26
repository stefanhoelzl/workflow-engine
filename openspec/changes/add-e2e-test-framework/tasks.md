## 1. PR 1 — Framework MVP + test #14 (plain env round-trip)

- [x] 1.1 Create `packages/tests/` with `package.json` (private, name `@workflow-engine/tests`, deps on vitest, runtime, sdk, core), `tsconfig.json`, `vitest.config.ts` (project name `tests`, include `test/**/*.test.ts`)
- [x] 1.2 Add root `package.json` script `"test:e2e": "pnpm build && vitest run --project tests"`
- [x] 1.3 Implement `packages/tests/src/index.ts` exporting exactly `{describe, test, expect}` (expect re-exported from vitest); export the FROZEN type signatures for the entire framework surface (Scenario, ScenarioState, CapturedSeq, MockClient, BrowserContext, all opts types) so PRs 2-17 don't refactor signatures
- [x] 1.4 Implement `packages/tests/src/spawn.ts`: spawn child runtime, tail stdout, parse pino JSON lines, resolve when `http.listening` line appears, expose stop() + sigterm/sigkill helpers
- [x] 1.5 Implement `packages/tests/src/fixtures.ts`: write inline source to tmp `.ts`, run `build()` from `@workflow-engine/sdk/cli` (no cache yet), return bundle dir path
- [x] 1.6 Implement `packages/tests/src/upload.ts`: thin wrapper calling `upload()` from `@workflow-engine/sdk/cli`
- [x] 1.7 Implement `packages/tests/src/scenario.ts`: lazy chain queue, `.workflow(name, source)`, `.webhook(name, {body})`, `.expect(callback)` with retry-on-state-change + hardCap, internal `.run()`. Stub `.upload`, `.fetch`, `.manual`, `.waitForEvent`, `.sigterm`, `.sigkill`, `.browser` to throw "not implemented in this build"
- [x] 1.8 Implement `packages/tests/src/describe.ts` (vitest describe wrapper, manages app lifecycle, exposes app via context) and `packages/tests/src/test.ts` (vitest test wrapper, builds scenario, calls .run)
- [x] 1.9 Implement `CapturedSeq<T>` (readonly array + `byIndex` + `byLabel`); `byLabel` throws "not implemented" until PR 6
- [x] 1.10 Stub `state.workflows`, `state.uploads`, `state.fetches`, `state.events`, `state.archives`, `state.logs` as empty CapturedSeq / empty arrays; stub `state.http`, `state.smtp`, `state.sql` as MockClient placeholders that throw on any method call
- [x] 1.11 Write test #14 at `packages/tests/test/14-env-roundtrip.test.ts`: workflow with `wf.env.GREETING`, webhook fires, expect response body equals `{g: "hello-from-cli"}`
- [x] 1.12 Add new GitHub Actions job for `pnpm test:e2e` as a parallel job in `.github/workflows/ci.yml` (required check from PR 1, superseding the proposal's "advisory for ~one week" plan); cache `~/.cache/embedded-postgres` and `~/.cache/ms-playwright` for later phases
- [x] 1.13 Verify `pnpm test:e2e` passes locally and in CI

## 2. PR 2 — `.webhook` body/headers/query + test #15 (httpTrigger protocol adapter)

- [x] 2.1 Extend `.webhook(name, opts)` to accept `{body?, headers?, query?}`; serialize headers and query into the HTTP request
- [x] 2.2 Extend `state.responses` capture to include `status`, `headers`, parsed body
- [x] 2.3 Write test #15: workflow with httpTrigger that echoes body + headers + query into response with custom status/headers; webhook fires positive case + negative case (422 on schema mismatch)
- [x] 2.4 Verify both happy and negative paths pass

## 3. PR 3 — `.waitForEvent` (FS polling) + test #16 (cronTrigger fires)

- [x] 3.1 Implement `.waitForEvent(filter, opts)`: poll `<persistencePath>/pending/*.json` and `<persistencePath>/archive/*.json` at ~25 ms cadence; match against `{label?, kind?, archived?, trigger?, owner?, repo?}`; throw with diagnostic on timeout
- [x] 3.2 Implement `state.events`: read from persistence dir on demand inside `.expect` callbacks (so retries pick up new events)
- [x] 3.3 Write test #16: cronTrigger with `* * * * * *`; chain just uploads then `.waitForEvent({trigger: "tick", kind: "trigger.response"})`; expect each invocation event carries the expected `(owner, repo, workflow)` (the sub-2 s duration is implicit in the framework's 5 s hardCap)
- [x] 3.4 Verify wall-clock cron fires within 5 s hardCap

PR 3 also drops `STANDARD_CRON_RE` from the manifest layer; `cron-parser` (already used by the runtime cron source) becomes the sole runtime grammar authority. The SDK's compile-time `ts-cron-validator` check on hand-written `cronTrigger({schedule: …})` literals is unchanged. This unblocks 6-field every-second cron schedules in fixture-string sources required by tests #16 and #6 without weakening the author-facing 5-field guarantee. Spec deltas land under `specs/cron-trigger/` and `specs/workflow-manifest/`.

## 4. PR 4 — Multi-workflow + explicit `.upload()` + test #6 (multi-backend reconfigure)

- [x] 4.1 Allow `.workflow()` to be called multiple times before an upload; queue per `(owner, repo)` group
- [x] 4.2 Implement `.upload({label?})`: explicit flush of queued workflows, one upload per `(owner, repo)`; populate `state.uploads`
- [x] 4.3 Implement implicit upload before any fire step that needs registered workflows
- [x] 4.4 Write test #6: one workflow with both `httpTrigger("ping")` and `cronTrigger(every-second, "tick")`; upload once; webhook fires; waitForEvent for both `ping` and `tick` trigger.response events
- [x] 4.5 Verify both triggers reachable after one upload

## 5. PR 5 — Owner/repo opts + test #19 (owner/repo scoping)

- [x] 5.1 Add `{owner?, repo?}` opts to `.workflow`, `.webhook`, `.manual`; default to `(dev, e2e)`
- [x] 5.2 Extend `state.workflows` entries to carry `{name, sha, owner, repo}`
- [x] 5.3 Write test #19: same workflow source uploaded under three different `(owner, repo)` tuples; webhook fires against each; expect each invocation attributed to its tuple; expect events scoped correctly
- [x] 5.4 Verify cross-tuple isolation in events

## 6. (Optional) Perf PR — Fixture build cache

- [ ] 6.1 Implement `packages/tests/src/fixtures/cache.ts`: cache key `sha256([source, name, owner, repo])`, path `node_modules/.cache/wfe-tests/<key>/`
- [ ] 6.2 Implement `globalSetup` for the cache: compute SDK+core dist hash, compare to `.build-hash` sentinel, wipe `wfe-tests/*` and rewrite sentinel if mismatch
- [ ] 6.3 Use `mkdtemp` + atomic `rename` for concurrent writes
- [ ] 6.4 Verify cache hit on second test run (build time drops to ~0 for cached fixtures)
- [ ] 6.5 Verify SDK src edit + `pnpm build` causes cache wipe and rebuild

## 7. PR 6 — Labels + LogStream waitFor/query + test #5 (re-upload + eviction log)

- [ ] 7.1 Add `label?: string` opt to `.workflow`, `.upload`, `.fetch`, `.webhook`, `.manual`
- [ ] 7.2 Implement `CapturedSeq.byLabel`: throw with clear error when label not found
- [ ] 7.3 Implement `LogStream.waitFor(predicate, opts)` and `LogStream.query(predicate)` reading from the buffered pino lines
- [ ] 7.4 Write test #5: scenario uploads `reup` with v1, webhooks, expects v1 ran; uploads `reup` with v2, webhooks, expects v2 ran AND `state.logs` contains a `sandbox evicted` line carrying v1's sha (read via `state.uploads[0].workflows[0].sha`)
- [ ] 7.5 Verify eviction log captured and matched

## 8. PR 7 — `describe(name, {env}, body)` + test #7 (LRU eviction under count pressure)

- [ ] 8.1 Implement `describe(name, opts, body)` overload accepting `{env?: Record<string, string>}`; merge into spawned child env
- [ ] 8.2 Write test #7 inside `describe("LRU", {env: {SANDBOX_MAX_COUNT: "2"}}, app => ...)`: upload 3 fixtures sequentially, fire each, expect a `sandbox evicted` log line with `reason: "lru"` after the 3rd upload
- [ ] 8.3 Verify LRU eviction triggered by count pressure with the specific log shape

## 9. PR 8 — Log scoping (mark/since) + assertNotPresent + test #1 (sealed secret)

- [ ] 9.1 Implement `LogStream.mark()` returning an opaque marker; `LogStream.query` and `LogStream.assertNotPresent` accept `{since?: marker}` and default to the test's auto-mark
- [ ] 9.2 Wire framework `beforeEach` to call `mark()` per test; framework auto-randomizes secret values per test as belt-and-braces
- [ ] 9.3 Implement secret support in inline source via `secret(name)` from sdk; framework passes secret value at upload time (sealed against the runtime's pubkey via the existing upload flow)
- [ ] 9.4 Write test #1: workflow with `secret('API_KEY')`, handler echoes the plaintext, webhook fires, expect response body contains the plaintext, AND `state.logs` does not contain the plaintext (auto-randomized per test)
- [ ] 9.5 Verify positive (handler reads plaintext) AND negative (no plaintext in any log line) both pass

## 10. PR 9 — `.sigkill` + restart + test #2 (crash recovery)

- [ ] 10.1 Implement `.sigkill(opts)`: send SIGKILL to child, await `exit` event
- [ ] 10.2 Implement `{restart: true}`: respawn against same `PERSISTENCE_PATH` and other env from original spawn; await `http.listening` of the new child
- [ ] 10.3 Write test #2: workflow with manualTrigger that sleeps via setTimeout 5s; chain fires it (labeled), waitForEvent `{label, archived: false}` (pending file landed), sigkill with restart, waitForEvent `{label, archived: true}`, expect events contains a `trigger.error` with `error.kind: "engine_crashed"`
- [ ] 10.4 Verify the action does NOT complete naturally (would be a test-bug-detector — handler throws after sleep)
- [ ] 10.5 Verify recover() sweep produces engine_crashed on respawn

## 11. PR 10 — `.sigterm` + `shutdown.complete` runtime line + test #3 (SIGTERM drain)

- [ ] 11.1 Add `runtimeLogger.info("shutdown.complete", {code, durationMs})` to `packages/runtime/src/main.ts` shutdown handler, after Promise.allSettled of service stops, before `process.exit(code)`
- [ ] 11.2 Update `service-lifecycle/spec.md` with the new requirement (already drafted in the change's spec delta — copy at archive time)
- [ ] 11.3 Implement `.sigterm(opts)`: send SIGTERM, await `shutdown.complete` log line on stdout before child exits
- [ ] 11.4 Implement `.sigterm({restart: true})`: respawn after graceful shutdown
- [ ] 11.5 Write test #3: workflow with manualTrigger that sleeps 500ms then returns; chain fires, waitForEvent `{label, archived: false}`, sigterm with restart, waitForEvent `{label, archived: true, kind: "trigger.response"}`; expect no `engine_crashed` and archive contains the success output
- [ ] 11.6 Verify in-flight invocation drained to a successful archive

## 12. PR 11 — `.fetch` + test #4 (health endpoint)

- [ ] 12.1 Implement `.fetch(path, opts)`: GET (default) or method specified in opts; capture status/headers/body into `state.fetches` (CapturedSeq); `as: "json"|"text"|"response"` controls body parsing (default infers from content-type)
- [ ] 12.2 Write test #4: chain just calls `.fetch("/health")`, expects `fetches[0].status === 200` and shape matches `{eventStore: "ok", storage: "ok", version: any}`
- [ ] 12.3 Verify health endpoint reachable after spawn

## 13. PR 12 — `.fetch` auth resolution + test #8 (cross-owner 404 isolation)

- [ ] 13.1 Implement `auth: {user, via: "cookie" | "api-header"}` resolution: `via: "cookie"` POSTs to `/auth/local/signin` with `name=user`, captures sealed `session` cookie; `via: "api-header"` adds `Authorization: User <user>` and `X-Auth-Provider: local` headers; cache per `(child, user, via)`
- [ ] 13.2 Write test #8: upload one workflow under `(acme, e2e)` as `alice`; chain calls `.fetch("/api/workflows/acme", {auth: {user: "bob", via: "api-header"}, label: "bobApi"})`, `.fetch("/dashboard/acme", {auth: {user: "bob", via: "cookie"}, label: "bobDash"})`, `.fetch("/api/workflows/acme", {auth: {user: "alice", via: "api-header"}, label: "aliceApi"})`; expect bobApi=404, bobDash=404, aliceApi=200
- [ ] 13.3 Verify cross-owner enumeration returns 404, alice sanity passes

## 14. PR 13 — Mock infrastructure + HTTP echo mock + test #17 (fetch SSRF guard)

- [ ] 14.1 Implement `MockCapture` interface and `Mock<TCapture, TConn>` interface
- [ ] 14.2 Implement `createMockServer(mock)` factory: wires uniform admin server with `GET /captures?slug&since`, `GET /stream?slug` (SSE with replay-on-connect), `POST /reset?slug`
- [ ] 14.3 Implement `MockClient<TCapture>` with `captures`, `waitFor` (SSE), `reset`; ECONNREFUSED detection with clear error
- [ ] 14.4 Implement `HttpEchoMock` (request capture with slug derived from URL path)
- [ ] 14.5 Implement `globalSetup` in vitest config to boot mocks once per suite, `provide("mocks", {...})`; `globalTeardown` to stop them
- [ ] 14.6 Wire `inject("mocks")` in workers; populate `state.http` with a real MockClient pointing at `mocks.echo.adminUrl`
- [ ] 14.7 Implement per-test slug derivation: `<file-basename>-<describe>-<test>`, slugified, hash-suffix overflow handling
- [ ] 14.8 Write test #17: workflow handler tries `fetch(env.LOOPBACK_URL)`; chain uploads with `LOOPBACK_URL = mocks.echo.url + "/<slug>/"`, fires webhook, expects response body indicates SSRF rejection AND `mocks.http.captures({slug})` has zero entries
- [ ] 14.9 Verify hardenedFetch rejects loopback at runtime; echo mock confirms request never arrived

## 15. PR 14 — SMTP catcher mock + test #18 (sendMail + redaction)

- [ ] 15.1 Implement `SmtpMock` using `smtp-server` from nodemailer (or hand-roll ~50 lines): random user/password per suite, capture mails with slug derived from recipient plus-address (`dest+<slug>@test`)
- [ ] 15.2 Wire into `globalSetup` provide; populate `state.smtp` MockClient
- [ ] 15.3 Write test #18: workflow handler calls `sendMail({...auth: {user, pass: secret('SMTP_PASS')}, to: \`dest+\${slug}@test\`, ...})`; chain uploads with mock SMTP creds + slug-tagged recipient, fires webhook, expects response 202 AND `mocks.smtp.captures({slug})` length 1 AND password not in any log line
- [ ] 15.4 Verify mail delivered to the correct slug; verify password redacted in logs

## 16. PR 15 — Postgres mock with TLS + tests #12 + #13 (SQL TLS + statement_timeout)

- [ ] 16.1 Implement `PgMock` using `embedded-postgres`: configurable TLS (self-signed cert bundled in `packages/tests/mocks/pg-tls/`), expose URL + CA PEM
- [ ] 16.2 Wire SQL capture: enable `log_statement=all` in the cluster, tail logs, parse statements into `SqlCapture`
- [ ] 16.3 Wire into `globalSetup` provide; populate `state.sql` MockClient
- [ ] 16.4 Write test #12 (TLS handshake): workflow handler calls `executeSql({connection: {url, ssl: {ca}}, query: "SELECT 1 AS n"})`; chain uploads with mock pg URL + CA, fires manual, expects archive output `{n: 1}`
- [ ] 16.5 Write test #13 (statement_timeout): workflow handler calls `executeSql({connection: {url, statementTimeout: 100}, query: "SELECT pg_sleep(1)"})`; chain fires, waitForEvent for trigger.error, expects archive error matches /statement timeout|canceling/
- [ ] 16.6 Verify both: real TLS handshake AND server-side timeout cancellation

## 17. PR 16 — Playwright + `.browser` + login helper + test #9 (login + signout)

- [ ] 17.1 Add `@playwright/test` (or `playwright`) dev dep; document `pnpm exec playwright install chromium` in README
- [ ] 17.2 Implement chromium browser launched once per worker (suite-wide via vitest fixtures); fresh `BrowserContext` per `.browser` step with `baseURL: child.baseUrl`
- [ ] 17.3 Implement `.browser(callback)` chain step; callback receives `{page, state, login}`
- [ ] 17.4 Implement `login(user)` helper: drive `/login` form, select user, submit, await `/dashboard` URL
- [ ] 17.5 Write test #9: chain has just one `.browser` step; navigates to `/login`, selects `dev`, submits, asserts `/dashboard`, reloads, asserts session persists, clicks signout, asserts `/login`, navigates back to `/dashboard`, asserts redirect to `/login`
- [ ] 17.6 Verify full login + signout flow under chromium

## 18. PR 17 — Tests #10 + #11 (dashboard + trigger UI)

- [ ] 18.1 Write test #10: chain workflows + webhooks (with completion expectation); browser step uses `login("dev")`, navigates to `/dashboard/dev/e2e`, locates `[data-workflow="${state.workflows[0].name}"]` row, asserts visible and contains `kind-trigger` for `ping`
- [ ] 18.2 Write test #11: workflow with manualTrigger `greet({name})` returning `{hello: "hi <name>"}`; browser step logs in, navigates to `/trigger/dev/e2e/<workflow>/greet`, fills `input[name="name"]` with `world`, submits, asserts `[data-role="response"]` contains `"hello": "hi world"`
- [ ] 18.3 Verify both UI tests pass under chromium

## 19. CI promotion

- [x] 19.1 After PR 1 lands and ~one week of green `test:e2e` runs, promote the job to a required check on `main` (done in PR 1: the job is part of `ci.yml` from the outset, no `continue-on-error`)
- [ ] 19.2 Update `CLAUDE.md` "Definition of Done" section pointing at `pnpm test:e2e` (separate from `pnpm validate`)
- [ ] 19.3 Add `packages/tests/README.md` documenting the test-author surface (the three exports, the chain DSL, the no-escape-hatch rule, the slug convention, mock interaction patterns)
