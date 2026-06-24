import type { Child } from "hono/jsx";
import { ChevronIcon } from "../icons.js";

// ---------------------------------------------------------------------------
// EntryRow — shared component for every UI surface that renders an
// expandable list of records (currently `/invocations` and `/queue` items).
// Owns the <details>/<summary> mechanic, chevron, hover state, base grid
// layout, and the 3px ::before status / kind strip. Per-surface variation
// (grid template, strip color source) is expressed via CSS modifier classes
// on `.entry-summary` and on the row itself.
//
// Per ui-foundation §Shared expandable-list-row component (queues-on-duckdb
// change): surfaces SHALL NOT hand-roll <details>/<summary> for the same
// purpose. The component is CSP-clean — no inline scripts, styles, or x-data
// object literals; htmx lazy-load wiring rides `hx-*` attributes consumed by
// the external htmx script.
//
// Expansion modes (discriminated by `expand.kind`):
//   - "htmx":   the body is fetched lazily on first open via `hx-get`.
//               Used by `/invocations` rows (flamegraph fragments).
//   - "inline": the body is rendered server-side at construction time.
//               No htmx attributes are emitted. Used by `/queue` item rows
//               whose body (a JSON tree) is already cheap to inline.
//   - omitted:  the row is non-expandable; renders as a plain <div>.
// ---------------------------------------------------------------------------

type ExpandSpec =
	| {
			readonly kind: "htmx";
			readonly hxGet: string;
			readonly hxTarget: string;
			readonly hxSwap?: string;
	  }
	| { readonly kind: "inline" };

interface EntryRowProps {
	// Stable DOM id for anchoring (e.g. `inv-<id>`, `qi-<seq>`).
	readonly id: string;
	// Status strip modifier (e.g. `s-succeeded`, `s-failed`, `s-pending`,
	// `s-upload`, or empty). Drives the 3px `::before` strip color via the
	// `.entry.<statusClass>::before` selectors.
	readonly statusClass?: string;
	// Surface modifier on `.entry-summary` that sets `grid-template-columns`.
	// Required so the base selector doesn't pin a single column count.
	readonly summaryModifier:
		| "entry-summary--invocations"
		| "entry-summary--queue";
	// Optional extra modifier classes on the outer row element (e.g.
	// `entry--removed` for tombstones).
	readonly extraClass?: string;
	// Expansion mode; omitted → non-expandable.
	readonly expand?: ExpandSpec;
	// The summary row cells, in their per-surface order. The leading chevron
	// is rendered by EntryRow itself — callers SHALL NOT include one.
	readonly children: Child;
	// The body slot. Rendered inside the <details> when `expand` is set;
	// ignored otherwise. For htmx mode the body usually contains an empty
	// slot the fragment swaps into; for inline mode the body is the actual
	// content.
	readonly body?: Child;
	// Accessibility label for the <summary>. Defaults to "Expand row details".
	readonly summaryLabel?: string;
}

function EntryRow(props: EntryRowProps) {
	const {
		id,
		statusClass = "",
		summaryModifier,
		extraClass = "",
		expand,
		children,
		body,
		summaryLabel = "Expand row details",
	} = props;
	const rowCls = [
		"entry",
		expand ? "entry-expandable" : null,
		statusClass,
		extraClass,
	]
		.filter((c): c is string => Boolean(c))
		.join(" ");
	const summaryCls = `entry-summary ${summaryModifier}`;
	if (!expand) {
		return (
			<div class={rowCls} id={id}>
				<span
					class="entry-expand-chevron entry-expand-chevron--placeholder"
					aria-hidden="true"
				/>
				{children}
			</div>
		);
	}
	if (expand.kind === "inline") {
		return (
			<details class={rowCls} id={id}>
				<summary class={summaryCls} aria-label={summaryLabel}>
					<span class="entry-expand-chevron" aria-hidden="true">
						<ChevronIcon />
					</span>
					{children}
				</summary>
				{body}
			</details>
		);
	}
	return (
		<details
			class={rowCls}
			id={id}
			hx-get={expand.hxGet}
			hx-trigger="toggle once"
			hx-target={expand.hxTarget}
			hx-swap={expand.hxSwap ?? "innerHTML"}
		>
			<summary class={summaryCls} aria-label={summaryLabel}>
				<span class="entry-expand-chevron" aria-hidden="true">
					<ChevronIcon />
				</span>
				{children}
			</summary>
			{body}
		</details>
	);
}

export type { EntryRowProps, ExpandSpec };
export { EntryRow };
