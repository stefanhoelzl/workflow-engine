## MODIFIED Requirements

### Requirement: Login page route

`GET /login` SHALL be a provider-agnostic sign-in page. The URL is deliberately not scoped under any single provider's `/auth/<id>/` prefix so multiple providers can be offered on the same page.

The route SHALL always render an HTML page — it SHALL NEVER initiate a provider flow or redirect to an IdP on its own. A provider flow SHALL start only when the user clicks/submits a provider-specific control on the page.

Behavior:
1. Read the `returnTo` query parameter; sanitize to a same-origin relative path (default `/`).
2. Read the `auth_flash` cookie if present; unseal and clear it.
3. Iterate the provider registry in registration order. For each registered provider, call `provider.renderLoginSection(returnTo)` and concatenate the returned `HtmlEscapedString` into the login card.
4. Respond `200 OK` with an HTML page containing:
   - The brand element.
   - The provider sections from step 3 (or no sections if the registry is empty).
   - If the flash payload was `{ kind: "denied", login }`: a "Not authorized" banner identifying the rejected login and containing an inline prose link to `https://github.com/logout` framed as account-switching guidance (for example, "To try a different account, sign out of GitHub first"). The link SHALL be rendered as a plain anchor inside the banner body, SHALL include `target="_blank"` and `rel="noopener noreferrer"`, and SHALL NOT be rendered as a styled action button in the action area.
   - If the flash payload was `{ kind: "logged-out" }`: a "Signed out" banner with no GitHub-related body addendum and no GitHub signout link anywhere on the page.
   - No banner when no flash cookie is present.

The HTML SHALL contain no inline script, no inline style, no `on*=` event-handler attributes, and no `style=` attributes, per the app's CSP. The page SHALL NOT include the app chrome (topbar, sidebar, tenant selector) — it is a standalone layout for unauthenticated users.

When the registry is empty, the rendered card SHALL contain the brand and any flash banner but no provider sections; the page SHALL still respond `200 OK`. It is not an error to have no providers configured.

The `GET /login` handler SHALL NOT consult any provider-specific hook to render flash-banner addenda. `AuthProvider` SHALL NOT expose `renderFlashBody` or `renderFlashAction` methods; banner content is decided entirely by the login-page renderer from the `FlashPayload.kind` discriminator.

> **Note:** that the user "cannot proceed past the page" is an emergent consequence of rendering no provider sections (no button or form to submit), not a separate enforce point the handler needs to check. If the registry is empty, the login card renders with only the brand/banner; the handler does not inspect or reject this state, and there is no fallback redirect.

#### Scenario: Renders github section when only github is registered

- **GIVEN** registry contains only the github provider
- **WHEN** `GET /login?returnTo=/dashboard` is requested without a flash cookie
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain a "Sign in with GitHub" link to `/auth/github/signin?returnTo=%2Fdashboard`
- **AND** the body SHALL NOT contain a local-provider form

#### Scenario: Renders local section when only local is registered

- **GIVEN** registry contains only the local provider with entries `dev` and `alice`
- **WHEN** `GET /login` is requested
- **THEN** the body SHALL contain `<form … action="/auth/local/signin">`
- **AND** the form SHALL contain options for both `dev` and `alice`
- **AND** the body SHALL NOT contain a "Sign in with GitHub" link

#### Scenario: Renders both sections when both providers are registered

- **GIVEN** registry contains both github and local providers
- **WHEN** `GET /login` is requested
- **THEN** the body SHALL contain BOTH the github link AND the local form

#### Scenario: Renders empty card when registry is empty

- **GIVEN** registry contains no providers (`AUTH_ALLOW` unset)
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain the brand
- **AND** the body SHALL NOT contain any provider section
- **AND** the response SHALL NOT include a `Location` header

#### Scenario: Denied flash renders inline account-switch link, not an action button

- **GIVEN** an `auth_flash` cookie sealing `{ kind: "denied", login: "foo" }`
- **WHEN** `GET /login` is requested with any registry composition
- **THEN** the handler SHALL respond `200 OK` with a "Not authorized" banner naming `foo`
- **AND** the banner body SHALL contain a plain `<a>` to `https://github.com/logout` with `target="_blank"` and `rel="noopener noreferrer"`, framed as account-switching guidance
- **AND** the action area SHALL NOT contain any `btn`-styled "Sign out of GitHub" control
- **AND** the response SHALL include `Set-Cookie: auth_flash=; Max-Age=0`

#### Scenario: Logged-out flash renders a clean signed-out banner with no GitHub signout affordance

- **GIVEN** an `auth_flash` cookie sealing `{ kind: "logged-out" }`
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK` with a "Signed out" banner
- **AND** the rendered HTML SHALL NOT contain any reference to `https://github.com/logout`
- **AND** the rendered HTML SHALL NOT contain the phrase "Sign out of GitHub" in any button, link, or body text
- **AND** the action area SHALL contain only the registered providers' login sections
- **AND** the response SHALL include `Set-Cookie: auth_flash=; Max-Age=0`

#### Scenario: Refreshing the page stays on the page (no auto-redirect)

- **GIVEN** no flash cookie is present
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK`
- **AND** the response SHALL NOT include a `Location` header

#### Scenario: Malformed returnTo defaults to /

- **WHEN** `GET /login?returnTo=//evil.example` is requested with a github-only registry
- **THEN** the github section in the rendered page SHALL link to `/auth/github/signin?returnTo=%2F`

### Requirement: Logout route

`POST /auth/logout` SHALL clear the `session` cookie by emitting `Set-Cookie: session=; Path=/; Max-Age=0`, set an `auth_flash` cookie with payload `{ kind: "logged-out" }`, and respond `302 Found` with `Location: /login`.

The route SHALL accept only the POST method. Any other method (GET, HEAD, PUT, DELETE, PATCH) SHALL respond `405 Method Not Allowed`.

The route SHALL NOT require a valid session to operate — posting to `/auth/logout` with no cookie SHALL still clear the session, set the flash, and redirect. The handler SHALL NOT unseal or otherwise inspect the incoming `session` cookie contents; the `logged-out` flash payload is fixed and carries no provider attribution.

The route SHALL NOT attempt to revoke the access token at GitHub (GitHub OAuth Apps do not support server-side revocation that matches our model); logout is purely local cookie deletion. The signed-out banner rendered by `/login` SHALL NOT include any GitHub-IdP-logout affordance — our app's session and GitHub's session are independent logouts and we do not conflate them in the post-logout UI.

Redirecting to `/login` with the `logged-out` flash (rather than to `/`) is load-bearing for the UX: `/` triggers `redirect-root` → `/trigger` → `sessionMw` → `/login` → GitHub, which silently re-authenticates using the existing OAuth grant and re-issues a session cookie, making sign-out appear to have no effect. The flash cookie puts the login route into its banner-render branch, which breaks the chain at a route that does not require authentication.

#### Scenario: POST clears cookie, sets logged-out flash, redirects to login

- **WHEN** `POST /auth/logout` is requested with any cookie state
- **THEN** the handler SHALL respond `302 Found` with `Location: /login`
- **AND** the response SHALL include `Set-Cookie: session=; Path=/; Max-Age=0`
- **AND** the response SHALL include an `auth_flash` Set-Cookie whose sealed payload unseals to `{ kind: "logged-out" }`

#### Scenario: Login page renders signed-out banner with no GitHub logout link

- **GIVEN** `POST /auth/logout` just completed and set the `logged-out` flash cookie
- **WHEN** the browser follows the 302 to `/login`
- **THEN** the login route SHALL respond `200 OK`
- **AND** the body SHALL contain a "Signed out" confirmation
- **AND** the body SHALL contain the registered providers' login sections (e.g., "Sign in with GitHub")
- **AND** the body SHALL NOT contain any link, button, or text referencing `https://github.com/logout` or the phrase "Sign out of GitHub"

#### Scenario: GET is rejected

- **WHEN** `GET /auth/logout` is requested
- **THEN** the handler SHALL respond `405 Method Not Allowed`
- **AND** SHALL NOT clear any cookie
