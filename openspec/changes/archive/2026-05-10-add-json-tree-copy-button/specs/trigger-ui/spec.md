## MODIFIED Requirements

### Requirement: Result dialog renders payloads via the shared JSON tree

The trigger-fire result dialog (`result-dialog.js`) SHALL render JSON response bodies via the shared interactive JSON-tree component defined in `ui-foundation`, not via a `<pre>` element whose `textContent` is `JSON.stringify(payload, null, 2)`. The dialog's status banner and outcome visual states (success / warn / error) SHALL continue to behave as previously specified.

The dialog itself SHALL NOT render its own copy-to-clipboard control as a sibling of the rendered payload. The copy-to-clipboard affordance SHALL instead be provided by the shared JSON-tree component (see the "Shared interactive JSON-tree component" requirement in `ui-foundation`), which renders one control per tree mount. Each labelled block in the dialog renders exactly one tree and therefore exposes exactly one copy-to-clipboard control, preserving prior per-block copy parity.

#### Scenario: Result dialog renders the response body via the JSON tree

- **GIVEN** a successful trigger-fire returning body `{"ok": true, "output": {"id": "evt_42"}}`
- **WHEN** the result dialog opens
- **THEN** the response body SHALL be rendered via the shared JSON-tree component
- **AND** the dialog SHALL NOT contain a `<pre>` element whose textContent is `JSON.stringify` of the body

#### Scenario: Copy-to-clipboard preserves payload fidelity

- **GIVEN** a result dialog showing a JSON response body via the JSON-tree component
- **WHEN** the user activates the copy-to-clipboard control rendered inside the tree
- **THEN** the clipboard SHALL contain the original payload serialized via `JSON.stringify(payload, null, 2)` (not the tree's rendered HTML)

#### Scenario: Outcome visual states preserved across the migration

- **GIVEN** a trigger-fire returning HTTP `422` with body `{"error": "payload_validation_failed"}`
- **WHEN** the result dialog opens with the JSON-tree migration in effect
- **THEN** the dialog element SHALL still carry the warn visual class
- **AND** the banner SHALL still contain the outcome word for client error and the string `payload_validation_failed`
- **AND** the response body SHALL be rendered via the JSON-tree component

#### Scenario: Dialog does not render a sibling copy control

- **GIVEN** a result dialog rendered for any trigger-fire response body
- **WHEN** the dialog DOM is inspected
- **THEN** the dialog SHALL NOT contain an element with class `trigger-result-copy`
- **AND** the dialog SHALL NOT contain a copy-to-clipboard button as a sibling of the rendered tree's root element
- **AND** the copy-to-clipboard control SHALL appear inside the rendered JSON-tree's root element (i.e. as a descendant of the element carrying class `json-tree`)

#### Scenario: One copy control per labelled block

- **GIVEN** a result dialog rendering two labelled blocks (e.g. via `showResultBlocks([{label: "Request", payload: …}, {label: "Response", payload: …}], …)`)
- **WHEN** the dialog opens
- **THEN** the dialog SHALL contain exactly two copy-to-clipboard controls, one inside each block's rendered JSON-tree
