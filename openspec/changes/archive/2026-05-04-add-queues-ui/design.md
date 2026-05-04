## Context

Per-workflow durable FIFO queues already exist in the runtime as NDJSON files at `<PERSISTENCE_PATH>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson`, declared by workflow code via `defineQueue` and accessed only through the guest SDK's `put`/`get`. The current `queues` capability spec explicitly states *"There are no inspection or peek operations — `put` and `get` are the only surface."*

Authors and operators have asked for a way to look at queue contents without writing throwaway debug triggers (which destructively dequeue) or shell access (which doesn't compose with the membership-based authentication model). The existing UI surfaces — `/invocations` and `/trigger` — already follow a scope-based pattern (`/<surface>/:owner/:repo/:workflow`) with `requireOwnerMember()` enforcement and a shared in-page tab strip. A third surface mirroring the same shape is the natural place to land queue inspection.

Constraints established during discovery:

- **Read-only**: no clear/purge/peek-pop UI actions in v1. Mutation requires a separate proposal.
- **No new sandbox surface**: guest workflow code retains exactly `put`/`get`. The UI reads NDJSON files from the host process directly.
- **No new SDK API**: `defineQueue` and the `Queue<T>` interface are unchanged.
- **Server-rendered ethos**: cards and item fragments are server-rendered HTML; client JS is minimal Alpine for the JSON-tree component and the load-more append.
- **Queue file size is already bounded** (1000 items × 1024 bytes ≈ 1 MB max), so reading the full file per request is acceptable; pagination is a UI affordance, not a memory constraint.

Stakeholders: workflow authors (debugging stuck consumers), operators (verifying producer behaviour after deploys), security review (no new sandbox surface, fail-closed auth identical to `/trigger`).

## Goals / Non-Goals

**Goals:**
- Read-only inspection of queue contents at `/queue/:owner/:repo/:workflow/:queue` and parent scopes, mirroring the `/trigger` UX.
- A single shared interactive JSON-tree component that replaces the current `<pre>+JSON.stringify` rendering in `result-dialog.js` and powers the new queue items view.
- Preserve the guest-surface invariant that workflow code cannot inspect queues; relax only the host-side reading restriction in the spec.
- Tolerate concurrent `put`/`get` against the same queue file without blocking and without surfacing torn state.

**Non-Goals:**
- Mutating actions (clear queue, manually dequeue, manually enqueue test items).
- Auto-refresh / SSE / WebSocket live updates. Refresh is page reload.
- Sidebar tree changes (no queue leaves under workflows).
- Schema preview on the card (the manifest's queue JSON Schema is not surfaced).
- Per-item enqueue timestamps (NDJSON is raw items; adding an envelope would be a queue-file format change, out of scope).
- Renaming the existing "Trigger" tab (asymmetry with "Queues" is accepted).

## Decisions

### Decision 1: New top-level capability `queues-ui`, not folded into `queues`

**Choice:** Introduce a new capability spec `queues-ui` rather than extending the existing `queues` spec to cover the UI.

**Alternatives considered:**
- *Fold into `queues`*: keeps everything queue-related in one file. Rejected — mixes runtime/persistence concerns (FIFO semantics, fsync, file lifecycle) with UI concerns (HTTP routes, HTML cards, fragment endpoints), bloating the spec and tangling its test surface.
- *Extend `trigger-ui`* into a generic "scope-ui": rejected — `trigger-ui` already encodes trigger-specific shape (form rendering, manual fire POST). A new capability is cheaper than abstracting an existing one.

**Rationale:** The existing codebase pattern is one capability per coherent surface (`trigger-ui`, `invocations-list-view`, `ui-foundation`). `queues-ui` follows the precedent.

### Decision 2: Scope the `queues` "no inspection" invariant to the guest surface, not remove it

**Choice:** In `queues/spec.md`, modify the invariant to read "Workflow code SHALL have no inspection or peek operations…", and add a separate requirement permitting host-side read-only inspection.

**Alternatives considered:**
- *Remove the invariant entirely*: rejected — weakens the framing that the queue file format is an internal runtime detail. Future feature creep ("expose queue contents via guest SDK") would have one less guardrail.
- *Leave the invariant verbatim and document the host-read carve-out only in `queues-ui`*: rejected — splits the queue-file contract across two specs, making it easy for a future change to violate the invariant without noticing.

**Rationale:** The minimal-delta refinement makes the contract explicit at both endpoints (no guest peek; host may read read-only) in the canonical spec for queues.

### Decision 3: NDJSON read directly from disk, no new sandbox host-call

**Choice:** The runtime route handler reads the queue file from `<persistenceRoot>/queues/<owner>/<repo>/<workflow>/<queue>.ndjson` using `node:fs` and parses lines with `JSON.parse`, dropping any line that fails to parse (i.e. partial trailing line from a concurrent `put`).

**Alternatives considered:**
- *Add a `peek(offset, limit)` host-call to the queue plugin*: rejected — adds sandbox surface area for a UI-only feature with no guest consumers. Sandbox boundary changes carry security review weight; a host-only file read does not.
- *Buffered in-memory mirror of all queues*: rejected — duplicates state, breaks the "filesystem is source of truth" invariant of the queue lifecycle code.

**Rationale:** The queue file format (NDJSON, append-only `put`, atomic-rename `get`) is already the public contract within the runtime process. Reading it from another module in the same process is the simplest path that respects the existing single-writer property (the UI route does not write, and `node:fs` open-for-read does not block the writer).

### Decision 4: Concurrency tolerance via line-by-line tolerant parse, not file locking

**Choice:** The reader does `await readFile(path, "utf8")`, splits on `\n`, and `JSON.parse`s each non-empty line. Lines that throw are silently dropped. No file lock, no fcntl coordination with the writer.

**Alternatives considered:**
- *Use an advisory file lock during read*: rejected — would block `put`/`get` on the writer side, violating the "host inspection SHALL NOT block concurrent operations" requirement.
- *Read with a stat-based snapshot loop*: rejected — over-engineered for a < 1MB file; the failure modes are the same.

**Rationale:** The two writer operations have distinct atomicity guarantees:
- `put` = single `appendFile` syscall writing one complete line ending in `\n`. A reader observing a write in progress sees the previous lines committed and either no trailing line or a partial trailing line (not both halves of two adjacent items mixed). Dropping the partial line is correct.
- `get` = `writeFile(tmp) + fsync + rename`. The reader either observes the pre-rename file (open succeeded before rename, fd still points to old inode) or the post-rename file (fresh open after rename). Both are internally consistent; no torn state is observable.

```
        TIMELINE:    ─────────────────────────────────────────►

        Writer:      [appendFile "{\"a\":1}\n"]    [appendFile "{\"b\":2}\n"]
                                  │                            │
                                  ▼                            ▼
        File:        ...{"x":0}\n│                ...{"x":0}\n{"a":1}\n│
                                  │                                    │
        Reader:      open() ─────┴── readFile() ─── parse              │
                     opens before append; sees …{"x":0}\n              │
                                                                       │
        Reader:                       open() ─── readFile() ─── parse  │
                                      opens DURING append; may see     │
                                      …{"x":0}\n{"a":1                 │
                                      → partial trailing line dropped  │

        Reader:                                          open() ──────►
                                                         opens AFTER append;
                                                         sees full line
```

### Decision 5: Cards render eagerly listed but items load lazily

**Choice:** The scope page renders one collapsed `<details>` card per declared queue with an item count derived from a cheap newline-count of the file (no JSON parsing). The card body is empty until the user expands it; expanding fires a `fetch()` of `GET /queue/.../items?offset=0` returning a server-rendered HTML fragment that is appended to the card body. "Load more" buttons fetch `?offset=N` and append further fragments.

**Alternatives considered:**
- *Eager render all items at page load*: rejected — the user explicitly rejected this and asked for pre-rendered HTML on demand. Also: at root scope across many repos, eager render could read dozens of NDJSON files just to render a navigation page.
- *JSON endpoint + client-side rendering*: rejected — diverges from the codebase's server-rendered-HTML ethos, and the JSON-tree component already needs to render server-side once for the result-dialog migration; doing it server-side everywhere keeps one rendering path.

**Rationale:** Item-count-via-newline-count is O(file size) but bounded (~1 MB max); JSON-parse is O(items × item size). Counting newlines for the card scope page is cheap; full parse is reserved for expansion.

### Decision 6: Shared `wfe-json-tree` Alpine component, used inline + inside the modal

**Choice:** Create `packages/runtime/src/ui/static/json-tree.js` registering an Alpine component that takes a JSON value (passed via `x-data` attribute on a `data-*` hook → `Alpine.data` factory) and renders a collapsible tree. Default state: fully expanded. CSP-clean: no inline scripts, no inline styles, all bindings through `data-*` attributes and `Alpine.data` registration in a `/static/*.js` file (matching the existing UI security baseline).

**Migration of `result-dialog.js`:** Replace the `pre.textContent = JSON.stringify(payload, null, 2)` block with markup that mounts the JSON-tree component on the payload. Existing copy-to-clipboard button continues to work against the underlying value.

**Alternatives considered:**
- *Two separate components (one inline, one for modal)*: rejected — duplicates rendering logic and styling.
- *Pure server-rendered HTML tree (no Alpine)*: rejected — interactive collapse requires JS state. Server can render the initial fully-expanded tree, but click-to-collapse needs client behaviour.

**Rationale:** Single source of truth for JSON rendering across the app; trigger results, flamegraph action req/resp, and queue items all benefit.

### Decision 7: `/queue` URL singular; tab label "Queues" plural

**Choice:** URL prefix `/queue/...`, tab label `Queues`. Mirrors `/trigger` URL + `Trigger` tab label, but the new tab is plural.

**Rationale:** The user accepted the asymmetry to avoid renaming the existing `Trigger` tab. URL/tab divergence already exists today (`/trigger` URL ↔ `Trigger` tab, both singular). The proposal keeps `/queue` singular for URL/route consistency with `/trigger`, and uses the plural `Queues` label as the user requested.

### Decision 8: Card title is adaptive by scope

**Choice:** At `/queue` (root) cards show `<owner>/<repo>/<workflow>/<queue>`; at `/queue/:owner` they show `<repo>/<workflow>/<queue>`; at `/queue/:owner/:repo` they show `<workflow>/<queue>`; at `/queue/:owner/:repo/:workflow` they show just `<queue>`.

**Rationale:** Mirrors the breadcrumb pattern already used in the page tabs (the breadcrumb in `tabs.tsx` already shows scope-prefix segments). Disambiguates queues with the same name across different workflows at root scope.

### Decision 9: Sequence — request flow for the lazy items endpoint

```
   Browser                Hono                 ui/queue              FS
     │                     │                      │                  │
     │  GET /queue/o/r/w   │                      │                  │
     │ ─────────────────── │                      │                  │
     │                     │ sessionMw            │                  │
     │                     │ requireOwnerMember(o)│                  │
     │                     │ ────────────────────►│                  │
     │                     │                      │ registry.list()  │
     │                     │                      │ → declared queues│
     │                     │                      │ for (o,r,w)      │
     │                     │                      │ ────────────────►│
     │                     │                      │ stat() each .ndjson
     │                     │                      │ count newlines   │
     │                     │                      │◄─────────────────│
     │                     │ ◄─────────────────── │                  │
     │   200 HTML (cards)  │                      │                  │
     │ ◄─────────────────  │                      │                  │
     │                     │                      │                  │
     │  user expands card  │                      │                  │
     │  Alpine fires       │                      │                  │
     │  fetch(/items?off=0)│                      │                  │
     │ ─────────────────── │                      │                  │
     │                     │ sessionMw            │                  │
     │                     │ requireOwnerMember(o)│                  │
     │                     │ ────────────────────►│                  │
     │                     │                      │ readFile NDJSON  │
     │                     │                      │ ────────────────►│
     │                     │                      │◄─────────────────│
     │                     │                      │ split, JSON.parse│
     │                     │                      │ drop partial line│
     │                     │                      │ slice [off,off+50)│
     │                     │                      │ render fragment   │
     │                     │ ◄─────────────────── │                  │
     │   200 HTML fragment │                      │                  │
     │   (50 <article>s)   │                      │                  │
     │ ◄─────────────────  │                      │                  │
     │                     │                      │                  │
     │  Alpine appends to  │                      │                  │
     │  card body          │                      │                  │
```

## Risks / Trade-offs

- **[Risk] Read-while-rename race surfaces empty content briefly during `get`** → Mitigation: the reader opens the file fresh on each request; `rename` is atomic in POSIX. Either the open hits the old inode (fully consistent) or the new (fully consistent). No coordination needed. Verified by tests in `queue-fs-lifecycle.test.ts` already cover the rename atomicity.

- **[Risk] Partial trailing line interpreted as a malformed item** → Mitigation: the reader silently drops lines that fail `JSON.parse`. A scenario in the modified `queues` spec asserts this behaviour. Cost: a line that is malformed for *non-truncation* reasons (corruption, manual edit) would also be silently dropped — acceptable because the runtime owns the file and external corruption is a "support the user" matter, not a normal operating state.

- **[Risk] Item-count-via-newline-count is mildly expensive at root scope with many queues** → Mitigation: cap is 1000 items × 1024 bytes per queue ≈ 1 MB max. Even 100 queues is ≤ 100 MB of reads on a page render, which is acceptable for an authenticated, member-gated page. If this proves slow in production, a follow-up can add a cached `Content-Length`-based estimate or precomputed sidecar.

- **[Risk] `wfe-json-tree` migration breaks existing dialog visuals** → Mitigation: visual diff in dev (`pnpm dev`) on an existing trigger result + flamegraph action req/resp before merge. The existing CSS for `.trigger-result-body` is repurposed for the tree's container; nested levels get their own classes. Tasks include a manual probe step.

- **[Risk] CSP regression — Alpine component registers via inline `<script>`** → Mitigation: `Alpine.data('wfeJsonTree', factory)` lives in `/static/json-tree.js`, not inline. The card template binds via `x-data="wfeJsonTree"` referenced as a function, matching the existing pattern in `trigger-forms.js`.

- **[Risk] User enumeration via 404 timing on non-member access** → Mitigation: `requireOwnerMember()` is the same middleware `/trigger` uses; same fail-closed 404 contract; not a regression.

- **[Trade-off] No mutation primitives means a "stuck" queue still requires SSH or a debug trigger to drain** → Accepted: scope discipline. v1 is "see what's there"; mutation can come later as a separate proposal with its own auth/audit story.
