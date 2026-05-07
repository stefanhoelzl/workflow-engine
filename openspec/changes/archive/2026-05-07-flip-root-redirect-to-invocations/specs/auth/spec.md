## MODIFIED Requirements

### Requirement: Logout route

`POST /auth/logout` SHALL clear the `session` cookie by emitting `Set-Cookie: session=; Path=/; Max-Age=0`, set an `auth_flash` cookie with payload `{ kind: "logged-out" }`, and respond `302 Found` with `Location: /login`.

The route SHALL accept only the POST method. Any other method (GET, HEAD, PUT, DELETE, PATCH) SHALL respond `405 Method Not Allowed`.

The route SHALL NOT require a valid session to operate — posting to `/auth/logout` with no cookie SHALL still clear the session, set the flash, and redirect. The handler SHALL NOT unseal or otherwise inspect the incoming `session` cookie contents; the `logged-out` flash payload is fixed and carries no provider attribution.

The route SHALL NOT attempt to revoke the access token at GitHub (GitHub OAuth Apps do not support server-side revocation that matches our model); logout is purely local cookie deletion. The signed-out banner rendered by `/login` SHALL NOT include any GitHub-IdP-logout affordance — our app's session and GitHub's session are independent logouts and we do not conflate them in the post-logout UI.

Redirecting to `/login` with the `logged-out` flash (rather than to `/`) is load-bearing for the UX: `/` triggers `redirect-root` → `/invocations` → `sessionMw` → `/login` → GitHub, which silently re-authenticates using the existing OAuth grant and re-issues a session cookie, making sign-out appear to have no effect. The flash cookie puts the login route into its banner-render branch, which breaks the chain at a route that does not require authentication.

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
