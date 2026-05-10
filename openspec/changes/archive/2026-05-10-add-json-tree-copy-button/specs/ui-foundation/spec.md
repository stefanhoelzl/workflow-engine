## MODIFIED Requirements

### Requirement: Shared interactive JSON-tree component

Every UI surface that renders a JSON value to the user SHALL do so via a single shared interactive JSON-tree component, registered as an Alpine component in a same-origin `/static/*.js` module. UI surfaces SHALL NOT render JSON values via inline `<pre>` blocks containing the textual output of `JSON.stringify(value, null, 2)`.

The component SHALL satisfy the following invariants:

- **Default expansion**: when first rendered, every node in the tree SHALL be expanded. Nested objects, arrays, and scalar values SHALL all be visible without further user interaction.
- **Interactive collapse**: each node representing a non-empty object or array SHALL be individually collapsible and re-expandable by user activation (mouse click on a disclosure control or keyboard activation).
- **CSP-clean rendering**: the component SHALL register via `Alpine.data(...)` in a `/static/*.js` module and SHALL be bound through `data-*` attributes and Alpine directives that do not violate the existing CSP-clean rendering requirement (no inline `<script>` content, no inline `<style>`, no `on*=` handlers, no `style=` attributes, no inline `x-data` object literals).
- **Keyboard accessible**: the disclosure control on each collapsible node SHALL be reachable by keyboard tab navigation and SHALL be activatable by `Enter` or `Space`. The focus indicator SHALL conform to the existing keyboard-focus requirement.
- **Dark/light theme respect**: the component's visual treatment SHALL adapt to the user's `prefers-color-scheme` per the existing theme requirement; it SHALL NOT define theme-specific colours outside the established palette.
- **Reduced-motion respect**: any expand/collapse transition SHALL be suppressed when `prefers-reduced-motion: reduce` is set.
- **Copy-to-clipboard control**: every mount of the component SHALL render a copy-to-clipboard control as a child of the tree's root element. Activation of the control (mouse click or keyboard activation) SHALL write `JSON.stringify(value, null, 2)` of the *source value passed into the component* — not the rendered DOM text and not the tree's currently-visible (collapsed-aware) representation — to the system clipboard via `navigator.clipboard.writeText`. The control SHALL signal success by swapping its icon to a confirmation glyph and announcing "Copied" through a sibling `role="status"` `aria-live="polite"` region for assistive tech, then SHALL revert its icon and clear the announcement after a short delay (~2 seconds). The control SHALL be implemented via `addEventListener` on a button created by `document.createElement`; it SHALL NOT introduce inline event handlers, inline scripts, inline styles, or any binding that violates the CSP-clean rendering invariant. Empty containers (`{}`, `[]`) and primitive root values SHALL each carry the control.

The component SHALL be the single rendering path for all JSON values shown in the authenticated UI, including but not limited to: trigger-fire result payloads (existing trigger result dialog), action request/response payloads (existing flamegraph), and queue items (new `/queue` surface).

#### Scenario: Component renders fully expanded by default

- **GIVEN** a value `{"a": 1, "b": {"c": [2, 3]}}`
- **WHEN** the component renders the value for the first time
- **THEN** the keys `a`, `b`, and `c` SHALL all be visible without user interaction
- **AND** the array elements `2` and `3` SHALL all be visible without user interaction

#### Scenario: Collapse hides nested children

- **GIVEN** the component has rendered `{"a": 1, "b": {"c": [2, 3]}}` fully expanded
- **WHEN** the user activates the disclosure control next to key `b`
- **THEN** the elements `c`, `2`, and `3` SHALL no longer be visible
- **AND** key `a` and key `b` SHALL still be visible
- **AND** the component SHALL signal `b` as collapsed via an ARIA or `aria-expanded` attribute

#### Scenario: No inline-script or inline-style violations

- **WHEN** any page renders a JSON value through the component
- **THEN** the rendered HTML SHALL NOT contain a `<script>` element with inline content
- **AND** the rendered HTML SHALL NOT contain any `style=` attribute
- **AND** the rendered HTML SHALL NOT contain an `x-data="{...}"` object-literal binding
- **AND** the component SHALL register via `Alpine.data(...)` in a `/static/*.js` module loaded by `<script src="/static/...">`

#### Scenario: Keyboard activation toggles disclosure

- **WHEN** the user tabs focus to a disclosure control on a collapsible node
- **AND** the user presses `Enter` or `Space`
- **THEN** the node SHALL toggle between expanded and collapsed states
- **AND** focus SHALL remain on the disclosure control

#### Scenario: Component used uniformly across surfaces

- **WHEN** the trigger-fire result dialog renders a payload
- **THEN** the payload SHALL be rendered via the shared JSON-tree component, not via `<pre>` + `JSON.stringify`
- **WHEN** the queue items fragment renders an item
- **THEN** the item SHALL be rendered via the shared JSON-tree component
- **WHEN** the flamegraph displays an action's request or response payload
- **THEN** the payload SHALL be rendered via the shared JSON-tree component

#### Scenario: Copy-to-clipboard control writes the source value

- **GIVEN** the component has rendered the value `{"orderId": 42, "items": [{"sku": "X"}]}`
- **WHEN** the user activates the copy-to-clipboard control on the rendered tree
- **THEN** `navigator.clipboard.writeText` SHALL have been called exactly once
- **AND** the argument SHALL equal `JSON.stringify({"orderId": 42, "items": [{"sku": "X"}]}, null, 2)`

#### Scenario: Copy ignores collapsed state

- **GIVEN** the component has rendered `{"a": 1, "b": {"c": 2}}` and the user has collapsed key `b`
- **WHEN** the user activates the copy-to-clipboard control
- **THEN** the clipboard payload SHALL contain `"c": 2` (the source value, not the visible representation)

#### Scenario: Copy success announces and reverts

- **GIVEN** a rendered tree whose copy-to-clipboard control is in its idle state
- **WHEN** the user activates the control and the clipboard write resolves successfully
- **THEN** the control SHALL display a confirmation icon
- **AND** a sibling `role="status"` `aria-live="polite"` region SHALL contain the text "Copied"
- **AND** after a short delay (~2 seconds) the control SHALL revert to its idle icon
- **AND** the live region's text content SHALL be cleared

#### Scenario: Primitive and empty roots still carry the control

- **GIVEN** the component is asked to render the primitive value `null`
- **WHEN** the component renders the value
- **THEN** the rendered tree root SHALL still contain the copy-to-clipboard control
- **AND** activating it SHALL write the literal text `null` to the clipboard

- **GIVEN** the component is asked to render the empty object `{}`
- **WHEN** the component renders the value
- **THEN** the rendered tree root SHALL still contain the copy-to-clipboard control
- **AND** activating it SHALL write the literal text `{}` to the clipboard

#### Scenario: Copy control does not violate CSP

- **WHEN** any page renders a JSON value through the component
- **THEN** the copy-to-clipboard control SHALL NOT carry an inline `on*=` handler, an inline `style=` attribute, or be wired through an inline `<script>`
- **AND** the control's click behavior SHALL be installed via `addEventListener` from the same `/static/*.js` module that defines the component
