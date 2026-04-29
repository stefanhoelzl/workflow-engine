## MODIFIED Requirements

### Requirement: Login page route

`GET /login` SHALL be a provider-agnostic sign-in page. The URL is deliberately not scoped under any single provider's `/auth/<id>/` prefix so multiple providers can be offered on the same page.

The route SHALL always render an HTML page — it SHALL NEVER initiate a provider flow or redirect to an IdP on its own. A provider flow SHALL start only when the user clicks/submits a provider-specific control on the page.

Behavior:
1. Read the `returnTo` query parameter; sanitize to a same-origin relative path (default `/`).
2. Read the `auth_flash` cookie if present; unseal and clear it.
3. Iterate the provider registry in registration order. For each registered provider, call `provider.renderLoginSection(returnTo)` and embed the returned `JSX.Element` into the login card's JSX tree.
4. Respond `200 OK` with an HTML page containing:
   - The universal topbar per the `ui-foundation` "Universal topbar" requirement, rendered without user identity (the visitor is by definition not logged in on this route).
   - The provider sections from step 3 (or no sections if the registry is empty).
   - If the flash payload was `{ kind: "denied", login }`: a "Not authorized" banner identifying the rejected login and containing an inline prose link to `https://github.com/logout` framed as account-switching guidance (for example, "To try a different account, sign out of GitHub first"). The link SHALL be rendered as a plain anchor inside the banner body, SHALL include `target="_blank"` and `rel="noopener noreferrer"`, and SHALL NOT be rendered as a styled action button in the action area.
   - If the flash payload was `{ kind: "logged-out" }`: a "Signed out" banner with no GitHub-related body addendum and no GitHub signout link anywhere on the page.
   - No banner when no flash cookie is present.

The HTML SHALL contain no inline script, no inline style, no `on*=` event-handler attributes, and no `style=` attributes, per the app's CSP. The page SHALL render the universal topbar (per `ui-foundation`) but SHALL NOT include other authenticated app chrome — the sidebar and tenant selector SHALL NOT appear, since the visitor is unauthenticated and has no scope-bearing context to display.

The login card itself SHALL NOT embed a separate brand element — branding is delivered exclusively by the universal topbar above the card. The card body SHALL contain only the provider sections and any active flash banner.

When the registry is empty, the rendered card SHALL contain no provider sections and any active flash banner; the page SHALL still respond `200 OK`. It is not an error to have no providers configured. The universal topbar SHALL render its brand wordmark regardless of registry composition.

The `GET /login` handler SHALL NOT consult any provider-specific hook to render flash-banner addenda. `AuthProvider` SHALL NOT expose `renderFlashBody` or `renderFlashAction` methods; banner content is decided entirely by the login-page renderer from the `FlashPayload.kind` discriminator.

> **Note:** that the user "cannot proceed past the page" is an emergent consequence of rendering no provider sections (no button or form to submit), not a separate enforce point the handler needs to check. If the registry is empty, the login card renders with only the topbar and any banner; the handler does not inspect or reject this state, and there is no fallback redirect.

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
- **AND** the body SHALL render the universal topbar with the brand wordmark
- **AND** the body SHALL NOT contain any provider section
- **AND** the response SHALL NOT include a `Location` header

#### Scenario: Login page renders the universal topbar without user identity

- **WHEN** `GET /login` is requested
- **THEN** the rendered body SHALL include the universal topbar (per `ui-foundation`)
- **AND** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL NOT display any user identity element (since the visitor is unauthenticated)
- **AND** the body SHALL NOT contain a sidebar element

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
- **AND** the response SHALL NOT contain a `Location` header
