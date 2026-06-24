## ADDED Requirements

### Requirement: Shared expandable-list-row component

Every UI surface that renders an expandable list of records (currently `/invocations` and `/queue`; future similar surfaces) SHALL use a single shared `EntryRow` component, registered as JSX/TSX in the runtime's UI module tree (e.g. `packages/runtime/src/ui/shared/entry-row.tsx`). UI surfaces SHALL NOT hand-roll `<details>`/`<summary>` blocks for the same purpose.

The component SHALL own the following invariants:

- **Disclosure mechanism**: rows expand and collapse via a native `<details>`/`<summary>` element. The disclosure control SHALL be keyboard-activatable per the existing keyboard-focus requirement.
- **Chevron rotation**: the chevron glyph in the summary row SHALL rotate to indicate expanded vs collapsed state, animated subject to the existing reduced-motion respect requirement.
- **Hover state**: the row SHALL apply a subtle background-color change on `:hover` matching the established theme tokens for both light and dark schemes.
- **Status / kind strip**: each row SHALL render a 3-pixel-wide vertical strip flush to its left edge via a `::before` pseudo-element. The strip color SHALL be set by a per-surface CSS modifier class — `/invocations` uses status modifiers (`.s-succeeded`, `.s-failed`, `.s-pending`); `/queue` uses trigger-kind modifiers (`.k-cron`, `.k-http`, `.k-manual`, etc., color-aligned with the `--kind-*` tokens from `Cross-surface kind colour mapping`).
- **Grid layout**: the summary row SHALL use CSS grid for cell alignment. Per-surface variation in column count and widths SHALL be expressed via a CSS modifier class on the summary element (e.g. `.entry-summary--invocations`, `.entry-summary--queue`); the base `.entry-summary` selector SHALL define only the shared display, gap, alignment, and padding tokens.
- **CSP-clean rendering**: the component SHALL NOT introduce inline `<script>`, inline `<style>`, `on*=` handlers, `style=` attributes, or inline `x-data` object literals.

The component MAY accept a `fragmentUrl` for lazy-loading the expanded body's content on first open; the lazy-load mechanism (Alpine `wfeQueueCard` pattern, htmx `hx-get`, or equivalent) SHALL conform to the CSP-clean rendering invariant.

#### Scenario: Both invocations and queue surfaces consume the shared component

- **WHEN** the `/invocations` page renders its rows
- **THEN** the rendered HTML SHALL bear the shared `EntryRow` component's base class (e.g. `entry`/`entry-summary`)
- **AND** the markup SHALL NOT contain a per-page hand-rolled `<details>` block for invocation rows
- **WHEN** the `/queue/:owner/:repo/:workflow/:queue/items` fragment renders its rows
- **THEN** each row SHALL bear the same shared `EntryRow` component's base class
- **AND** the markup SHALL NOT contain a per-page hand-rolled `<details>` block for queue item rows

#### Scenario: Per-surface grid variation via modifier class

- **GIVEN** the shared `EntryRow` is rendered on `/invocations`
- **THEN** the summary element SHALL carry both the base class (e.g. `entry-summary`) and a surface-specific modifier (e.g. `entry-summary--invocations`)
- **AND** the surface modifier SHALL set `grid-template-columns` for that surface's column count and widths
- **GIVEN** the shared `EntryRow` is rendered on `/queue`
- **THEN** the summary element SHALL carry the base class and the `/queue` modifier (e.g. `entry-summary--queue`)
- **AND** the base `.entry-summary` selector SHALL NOT itself define `grid-template-columns`

#### Scenario: Status strip color is driven by a per-surface modifier class

- **GIVEN** an invocation row whose status is `succeeded`
- **THEN** the row SHALL carry the `.s-succeeded` modifier class
- **AND** the row's 3px `::before` strip SHALL be painted with the success-status color token
- **GIVEN** a queue row whose `trigger_kind` is `cron`
- **THEN** the row SHALL carry the `.k-cron` modifier class
- **AND** the row's 3px `::before` strip SHALL be painted with the cron `--kind-*` token

#### Scenario: No inline-script or inline-style violations

- **WHEN** any page renders rows via the shared `EntryRow` component
- **THEN** the rendered HTML SHALL NOT contain a `<script>` element with inline content
- **AND** the rendered HTML SHALL NOT contain any `style=` attribute
- **AND** the rendered HTML SHALL NOT contain an inline `x-data="{...}"` object-literal binding on the row element
- **AND** any lazy-load wiring (e.g. `data-*` attributes for Alpine or `hx-*` attributes for htmx) SHALL bind only via attributes consumed by an external `/static/*.js` module
