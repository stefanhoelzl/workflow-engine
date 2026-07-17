## 1. Comprehensive example workflow (land first)

- [x] 1.1 Create `packages/sdk/example/` with `example.ts` under a `src/` layout that `buildWorkflows({cwd})` can discover (or wire an explicit `opts.workflows` build entry).
- [x] 1.2 Author `example.ts` covering every author-facing surface: `httpTrigger` (GET+POST), `cronTrigger`, `manualTrigger`, `imapTrigger`, `wsTrigger`, `action` composition, `defineWorkflow`/`env`, `secret`, `defineQueue`, `executeSql`, `sendMail`, and at least one sandbox-stdlib global.
- [x] 1.3 Add explanatory TSDoc-style doc-comments to each surface in `example.ts`, including the strict-typecheck gotchas (`z.exactOptional`, `z.unknown()` for no-return actions, `.js` import extensions).
- [x] 1.4 Confirm `example.ts` bundles: run `wfe build` against it with placeholder env (mirror `workflows/package.json`'s `WEBHOOK_TOKEN`/`IMAP_USER`/`IMAP_PASSWORD` placeholders); assert typecheck + bundle succeed and no upload occurs.

## 2. CI bundle-validation gate

- [x] 2.1 Add a CI step (or workspace `build` script under `packages/sdk`) that bundle-validates `example.ts` on every PR — `wfe build`, no upload.
- [x] 2.2 Verify a deliberately broken `example.ts` (e.g. a `.optional()` field) fails the step non-zero locally.
- [x] 2.3 Confirm the gate covers `imapTrigger`/`wsTrigger` with no mail server or WS client present (compile-time only).

## 3. SDK README + TSDoc + packaging

- [x] 3.1 Rewrite `packages/sdk/README.md`: minimal `package.json`, install, `wfe build`/`wfe upload`, the CI deploy path, and the gotcha that `wfe build` enforces its own strict options and ignores the user's `tsconfig.json`.
- [x] 3.2 Add a one-line-purpose TSDoc doc-comment (+ `@example` or "see `example.ts`") to every author-facing value export in `packages/sdk/src/index.ts`.
- [x] 3.3 Extend `packages/sdk/package.json` `files` to include `example.ts` and `README.md`; run `npm pack --dry-run` and confirm both appear in the tarball listing.
- [x] 3.4 Confirm the built `.d.ts` retains the export doc-comments (`pnpm --filter @workflow-engine/sdk build`, inspect `dist/index.d.ts`).

## 4. Narrow demo.ts + migrate governance

- [x] 4.1 Narrow `workflows/src/demo.ts` to the triggers that actually run in `pnpm dev`; drop the infra-only kinds now carried by `example.ts`.
- [x] 4.2 Re-point `CLAUDE.md` `## Example workflows` and the "SDK surface change must update demo.ts" rule at `example.ts` (demo.ts becomes the runnable subset).
- [x] 4.3 Add a note to `openspec/project.md` on the `example.ts` (full-surface, bundle-validated) vs `demo.ts` (runnable subset, dev fixture) split.

## 5. Runtime /llms.txt index route

- [x] 5.1 Add a `GET /llms.txt` handler to the runtime returning a static constant (text/markdown), pointing at `unpkg.com/@workflow-engine/sdk@latest/` and instructing installed agents to prefer their `node_modules` copy.
- [x] 5.2 Mount it ahead of the 404 catch-all; confirm it is not shadowed by the root redirect (exact `/` only) or `/static/*`.
- [x] 5.3 Unit-test: handler returns byte-identical body across differing headers/query/method; no request input echoed.
- [x] 5.4 Add `/llms.txt` to the secure-headers integration route-family test; assert the full baseline header set on the response.
- [x] 5.5 Add the `/llms.txt` row to `SECURITY.md` §4 route table (`None / Intentional / Must stay non-sensitive`) with the static-constant invariant noted.

## 6. Verification

- [x] 6.1 Dev probe: boot `pnpm dev --random-port --kill`, wait for the `[READY]` marker, then `curl -s http://localhost:<port>/llms.txt` → 200, body references the unpkg path, and response carries the baseline security headers (`curl -sI`).
- [x] 6.2 Dev probe: `curl -s -o /dev/null -w '%{http_code}' http://localhost:<port>/llms.txt` with no cookie → `200` (not a `302` to `/login`).
- [x] 6.3 Run `pnpm validate` (lint + check + test + tofu fmt/validate) and confirm green.
- [x] 6.4 Run `pnpm --filter @workflow-engine/sdk build` and the example bundle gate; confirm green.

## Cluster smoke (human)

- [ ] H.1 After deploy, `curl -sI https://<env-host>/llms.txt` → `200`, textual content type, and the full baseline security-header set (CSP `default-src 'none'`, HSTS present in prod).
- [ ] H.2 Confirm `unpkg.com/@workflow-engine/sdk@latest/example.ts` and `.../README.md` resolve to the shipped content after the next SDK CalVer publish.
