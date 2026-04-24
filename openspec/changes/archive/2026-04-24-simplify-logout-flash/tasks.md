## 1. Interface and payload cleanup

- [x] 1.1 Remove `renderFlashBody?` and `renderFlashAction?` from the `AuthProvider` interface in `packages/runtime/src/auth/providers/types.ts`; drop the accompanying comment block.
- [x] 1.2 In `packages/runtime/src/auth/flash-cookie.ts`, remove the `provider` field from both the `denied` and `logged-out` variants of `FlashPayload`. Confirm no remaining import or reader references `FlashPayload["provider"]`.

## 2. GitHub provider cleanup

- [x] 2.1 Delete the `renderFlashBody()` and `renderFlashAction()` method implementations from `packages/runtime/src/auth/providers/github.ts` (the two methods around lines 262–271).
- [x] 2.2 In the GitHub callback denied path, stop stamping `provider: "github"` on the `auth_flash` cookie. The sealed payload on denial is `{ kind: "denied", login }` with no provider attribution.

## 3. Routes cleanup

- [x] 3.1 In `packages/runtime/src/auth/routes.ts`, simplify `loginPageMiddleware`: remove the `flashProvider`/`flashBody`/`flashAction` lookup block; pass only `{ flash, returnTo, sections }` to `renderLoginPage`.
- [x] 3.2 In `packages/runtime/src/auth/routes.ts`, simplify `POST /auth/logout`: remove the `unsealSession` call, the `provider` local, and the conditional spread. The handler clears the session cookie, seals `{ kind: "logged-out" }`, sets the flash cookie, and 302s to `/login`.
- [x] 3.3 Remove the comment in `routes.ts` that explains the provider-tagging rationale (no longer relevant).

## 4. Login page renderer changes

- [x] 4.1 In `packages/runtime/src/ui/auth/login-page.ts`, drop `flashBody` and `flashAction` from `LoginPageProps`. Remove the two `${props.flashBody ?? ""}` / `${props.flashAction ?? ""}` render sites.
- [x] 4.2 In the same file, update `bannerFor(flash)` so the `denied` branch's `bodyBase` contains the inline account-switch link: a plain `<a href="https://github.com/logout" target="_blank" rel="noopener noreferrer">` framed as "To try a different account, sign out of GitHub first." The `logged-out` branch remains "You have been signed out of this instance." with no additions.

## 5. Test updates

- [x] 5.1 Update `packages/runtime/src/auth/routes.test.ts` to drop any assertions that reference the old flash-addendum strings ("GitHub may still consider this browser signed in…", "Sign out of GitHub" as a button class). Add assertions matching the new spec scenarios: `logged-out` flash HTML contains no reference to `github.com/logout`; `denied` flash HTML contains a plain `<a>` to `github.com/logout` with `target="_blank"` and `rel="noopener noreferrer"` and no `btn`-styled signout control.
- [x] 5.2 Update `packages/runtime/src/auth/integration.test.ts` similarly; drop tests that depend on provider-attributed flash addenda.
- [x] 5.3 Grep the runtime package for any remaining references to `renderFlashBody`, `renderFlashAction`, or `flash.provider`; remove or update them.

## 6. Verify

- [x] 6.1 `pnpm lint` passes.
- [x] 6.2 `pnpm check` passes (TypeScript strict, exactOptionalPropertyTypes).
- [x] 6.3 `pnpm test` passes (unit + integration, excludes WPT).
- [x] 6.4 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (tenant=dev)`.
- [x] 6.5 Use `curl -c/-b cookiejar` to obtain a session cookie via `POST /auth/local/signin` with `name=dev`; `POST /auth/logout` → 302 to `/login`; follow the 302 and grep the rendered HTML: asserts NO `github.com/logout`, NO "Sign out of GitHub" substring, YES a "Signed out" banner heading.
- [x] 6.6 Seal a denied flash cookie manually (or drive a denied GitHub callback in an integration harness); `GET /login` with that cookie → grep HTML: asserts ONE plain `<a href="https://github.com/logout"` with `target="_blank"` and `rel="noopener noreferrer"` appearing inside the banner body (not in `auth-card__actions`), and NO `btn btn--secondary` signout button.

## 7. Spec sync

- [x] 7.1 Run `pnpm exec openspec validate simplify-logout-flash --strict`; resolve any structural issues.
- [x] 7.2 After implementation is verified, archive the change via `pnpm exec openspec archive simplify-logout-flash` so the delta is merged into `openspec/specs/auth/spec.md`.
