## ADDED Requirements

### Requirement: Result dialog renders payloads via the shared JSON tree

The trigger-fire result dialog (`result-dialog.js`) SHALL render JSON response bodies via the shared interactive JSON-tree component defined in `ui-foundation`, not via a `<pre>` element whose `textContent` is `JSON.stringify(payload, null, 2)`. The dialog's status banner, outcome visual states (success / warn / error), and copy-to-clipboard control SHALL continue to behave as previously specified.

#### Scenario: Result dialog renders the response body via the JSON tree

- **GIVEN** a successful trigger-fire returning body `{"ok": true, "output": {"id": "evt_42"}}`
- **WHEN** the result dialog opens
- **THEN** the response body SHALL be rendered via the shared JSON-tree component
- **AND** the dialog SHALL NOT contain a `<pre>` element whose textContent is `JSON.stringify` of the body

#### Scenario: Copy-to-clipboard preserves payload fidelity

- **GIVEN** a result dialog showing a JSON response body via the JSON-tree component
- **WHEN** the user activates the copy-to-clipboard control
- **THEN** the clipboard SHALL contain the original payload serialized via `JSON.stringify(payload, null, 2)` (not the tree's rendered HTML)

#### Scenario: Outcome visual states preserved across the migration

- **GIVEN** a trigger-fire returning HTTP `422` with body `{"error": "payload_validation_failed"}`
- **WHEN** the result dialog opens with the JSON-tree migration in effect
- **THEN** the dialog element SHALL still carry the warn visual class
- **AND** the banner SHALL still contain the outcome word for client error and the string `payload_validation_failed`
- **AND** the response body SHALL be rendered via the JSON-tree component
