## MODIFIED Requirements

### Requirement: Shared kind registry registers the manual kind

The shared trigger-kind registry at `packages/runtime/src/ui/triggers.ts` (consumed by both `/trigger` and `/invocations` UIs) SHALL contain entries for `"manual"` in BOTH of the following maps:

- `KIND_ICONS.manual` — a person-themed glyph (e.g., `"\u{1F464}"` — BUST IN SILHOUETTE).
- `KIND_LABELS.manual` — a short human-readable label (e.g., `"Manual"`).

Missing-kind fallback behaviour SHALL continue to apply unchanged to unrecognised kinds (icon falls back to `"\u{25CF}"`; label falls back to the raw kind string).

#### Scenario: Manual kind icon renders with correct metadata

- **GIVEN** a manual trigger card
- **WHEN** the page is rendered
- **THEN** the icon span SHALL contain the BUST IN SILHOUETTE glyph
- **AND** the span's `title` attribute SHALL equal `"manual"`
- **AND** the span's `aria-label` attribute SHALL equal `"manual"`

#### Scenario: Manual kind label resolves to the human-readable string

- **GIVEN** the `triggerKindLabel("manual")` helper
- **WHEN** called in any UI context that displays the label
- **THEN** the returned string SHALL equal `"Manual"`
