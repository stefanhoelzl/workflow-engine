## MODIFIED Requirements

### Requirement: Lazy form initialization

The `/trigger` UI SHALL initialise the form for a trigger card on demand, the first time the user expands the card. When the trigger's input schema declares user-settable fields (i.e. has `properties` or `additionalProperties`), the form SHALL render schema-derived inputs scoped to the expanded card; when the schema declares no user-settable fields, the card SHALL render the Submit control alone with no input form.

The form library and binding mechanism are implementation choices and are not part of this requirement; the contract is on the user-observable behaviour (form appears on first expand, schema fields drive the inputs, no form when no fields, Submit always present).

#### Scenario: First expansion renders the form

- **WHEN** a trigger card containing a schema with user-settable fields is expanded for the first time
- **THEN** the card SHALL render input controls derived from the schema fields
- **AND** the Submit control SHALL be present

#### Scenario: Subsequent toggles preserve form state

- **WHEN** a trigger card with a previously-initialised form is collapsed and re-expanded
- **THEN** the card SHALL re-display the same form
- **AND** any user-entered field values SHALL be preserved across the collapse/expand cycle

#### Scenario: Trigger with no user-settable inputs renders no form

- **GIVEN** a trigger whose input schema has neither `properties` nor `additionalProperties`
- **WHEN** the trigger card is rendered and expanded
- **THEN** no input form SHALL be rendered
- **AND** the Submit control SHALL be the only interactive element visible inside the card body

## REMOVED Requirements

### Requirement: Jedison styling

**Reason**: The choice of form library (Jedison) is implementation. The user-observable contract — form inputs render with the same theme as the rest of the application, and adapt to light/dark mode automatically — is owned by `ui-foundation` (theme detection via `prefers-color-scheme`) and the application's shared design tokens.

**Migration**: Form rendering must continue to follow the active theme (light/dark per `prefers-color-scheme`). The specific library used to render schema-driven forms, and the CSS hooks that style its output, are implementation choices documented in `docs/ui-guidelines.md` and the rendering code; they are not part of any spec.
