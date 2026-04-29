## ADDED Requirements

### Requirement: WS triggers listed alongside other kinds

The `/trigger/<owner>/<repo>/<workflow>` page SHALL list every `wsTrigger` registered for the workflow alongside HTTP, cron, manual, and IMAP triggers. WS trigger cards SHALL render a jedison form derived from the trigger's `request` schema (i.e. the schema for the inbound message `data`), identical to how the manual / cron / HTTP forms are rendered today.

The card SHALL render a `kind-trigger` span carrying the kind label `ws` (or equivalent) so dashboard scraping and CSS selectors can distinguish WS triggers visually.

#### Scenario: WS trigger renders as a card

- **GIVEN** a workflow with `export const chat = wsTrigger({ request: z.object({greet: z.string()}), handler })`
- **WHEN** the user opens `/trigger/<owner>/<repo>/<workflow>`
- **THEN** the page SHALL contain a card for `chat`
- **AND** the card SHALL render a jedison form for the `request` schema
- **AND** the card SHALL include a span identifying the trigger kind as `ws`

### Requirement: WS trigger manual fire dispatches via the manual path

Submitting a wsTrigger card's form SHALL fire the trigger via the same kind-agnostic manual-fire endpoint used for HTTP / cron / manual / IMAP cards. The runtime SHALL resolve the trigger by `(owner, repo, workflow, triggerName)`, run the handler once with the submitted JSON as the `data` field of the payload (`{data: <submitted>}`), and stamp the resulting invocation with `meta.dispatch.source = 'manual'`.

The handler's return SHALL be displayed in the existing result dialog using the same outcome rendering as other trigger kinds. No live WS connection is involved; in-flight WS clients SHALL NOT be notified by manual fires in v1.

#### Scenario: Submission fires via manual path

- **GIVEN** a wsTrigger `chat` with `request: z.object({greet: z.string()})`
- **WHEN** the user submits `{greet: "hi"}` from the trigger UI
- **THEN** the resulting invocation SHALL run the handler with `payload.data = {greet: "hi"}`
- **AND** the invocation SHALL carry `meta.dispatch.source = 'manual'`
- **AND** the handler return SHALL be rendered in the result dialog
