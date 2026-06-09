## ADDED Requirements

### Requirement: Removed kind icon registered in the trigger-kind registry

The cross-surface trigger-kind icon registry SHALL include an `removed` kind whose glyph is a archive box / archive shape and whose treatment is muted / de-emphasised (distinct from the live trigger-kind glyphs and from the `upload` accent kind). The `removed` kind is the rendered indicator for any sidebar tree leaf or invocation row whose `(workflow, trigger)` pair is no longer present in the `WorkflowRegistry` (a removed or renamed trigger).

The muted treatment SHALL be applied via a CSS rule selecting the `removed` variant of the trigger-kind icon container (e.g. `.trigger-kind-icon--removed`), following the icon-rendering invariants (inline SVG, theme-following colour).

The `removed` kind is a reserved sentinel and SHALL NOT be produced for any live trigger descriptor — a live trigger always carries its real declared kind (`cron`, `http`, `manual`, `imap`, …).

#### Scenario: Removed kind icon is registered alongside other kinds

- **WHEN** the trigger-kind registry is consulted for the kind string `"removed"`
- **THEN** the registry SHALL return a glyph component
- **AND** the glyph SHALL render as inline SVG following the icon-rendering invariants
- **AND** the glyph SHALL be visually distinct from the `cron` / `http` / `manual` / `imap` / `upload` glyphs

#### Scenario: Removed glyph is muted, not accent

- **GIVEN** a sidebar trigger leaf rendered with kind `removed`
- **WHEN** the leaf is rendered
- **THEN** the leading icon SHALL render the archive box/archive glyph
- **AND** its resolved colour SHALL be a muted/de-emphasised token, NOT the accent token used by the `upload` kind

#### Scenario: No live trigger descriptor yields the removed sentinel

- **GIVEN** a `WorkflowRegistry` populated with live triggers of kinds `cron`, `http`, `manual`, and `imap`
- **WHEN** any live trigger descriptor's kind is read
- **THEN** the value SHALL never be `"removed"`
