import type { Child } from "hono/jsx";
import { ChevronIcon, ManualIcon, TriggerKindIcon } from "../icons.js";
import { Layout } from "../layout.js";

const US_PER_MS = 1000;
const US_PER_SECOND = 1_000_000;
const US_PER_MINUTE = 60_000_000;
const DURATION_FRACTION_DIGITS = 1;

interface InvocationRow {
	readonly id: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly status: string;
	readonly startedAt: string | Date;
	readonly completedAt: string | Date | null;
	readonly startedTs: number;
	readonly completedTs: number | null;
	readonly triggerKind?: string;
	readonly dispatch?: {
		readonly source: "manual" | "trigger" | "upload";
		readonly user?: { readonly login: string; readonly mail?: string };
	};
	readonly synthetic?: boolean;
	readonly syntheticKind?:
		| "trigger.exception"
		| "trigger.rejection"
		| "system.upload";
	readonly rejectionSummary?: string;
	// Composed `cause(stage): message` for trigger.exception rows. Used as
	// the hover tooltip on the "trigger setup failed" pill — those rows
	// are non-expandable, so the tooltip is the only place the message
	// surfaces in the list view.
	readonly setupFailureMessage?: string;
	readonly uploadShaShort?: string;
	readonly exhaustion?: {
		readonly dim: "cpu" | "memory" | "output" | "pending";
		readonly budget?: number;
		readonly observed?: number;
	};
}

function startedAtMs(row: InvocationRow): number {
	const d =
		row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt);
	const t = d.getTime();
	return Number.isNaN(t) ? 0 : t;
}

function sortInvocationRows(rows: readonly InvocationRow[]): InvocationRow[] {
	return rows.slice().sort((a, b) => {
		const aPending = a.status === "pending";
		const bPending = b.status === "pending";
		if (aPending !== bPending) {
			return aPending ? -1 : 1;
		}
		return startedAtMs(b) - startedAtMs(a);
	});
}

function toIsoString(ts: string | Date): string {
	const d = ts instanceof Date ? ts : new Date(ts);
	return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

function formatDurationUs(us: number): string {
	const d = Math.max(0, us);
	if (d < US_PER_MS) {
		return `${d} µs`;
	}
	if (d < US_PER_SECOND) {
		return `${(d / US_PER_MS).toFixed(DURATION_FRACTION_DIGITS)} ms`;
	}
	if (d < US_PER_MINUTE) {
		return `${(d / US_PER_SECOND).toFixed(DURATION_FRACTION_DIGITS)} s`;
	}
	return `${(d / US_PER_MINUTE).toFixed(DURATION_FRACTION_DIGITS)} min`;
}

const EXHAUSTION_LABELS: Record<
	NonNullable<InvocationRow["exhaustion"]>["dim"],
	string
> = {
	cpu: "CPU",
	memory: "MEM",
	output: "OUT",
	pending: "PEND",
};

const EXHAUSTION_UNITS: Record<
	NonNullable<InvocationRow["exhaustion"]>["dim"],
	string
> = {
	cpu: "ms",
	memory: "bytes",
	output: "bytes",
	pending: "",
};

function ExhaustionPill({
	exhaustion,
}: {
	exhaustion: InvocationRow["exhaustion"];
}) {
	if (!exhaustion) {
		return null;
	}
	const label = EXHAUSTION_LABELS[exhaustion.dim];
	const unit = EXHAUSTION_UNITS[exhaustion.dim];
	const parts: string[] = [];
	if (exhaustion.budget !== undefined) {
		parts.push(`budget=${exhaustion.budget}${unit}`);
	}
	if (exhaustion.observed !== undefined) {
		parts.push(`observed=${exhaustion.observed}${unit}`);
	}
	const title = parts.length > 0 ? parts.join(" ") : label;
	return (
		<span class="entry-exhaustion" title={title}>
			{label}
		</span>
	);
}

// Single-cell metadata column. For manual dispatch, render the manual-trigger
// icon (person silhouette) — same glyph the manual trigger kind uses, so the
// dispatch source is shown with the same vocabulary as a trigger kind. Upload
// rows render no chip here: the leading kind icon already conveys upload.
// Synthetic exception/rejection rows render their distinguishing glyph here.
function MetaCell({ row }: { row: InvocationRow }) {
	if (row.syntheticKind === "trigger.exception") {
		const tooltip = row.setupFailureMessage ?? "trigger setup failed";
		return (
			<span
				class="entry-meta-cell entry-setup-failed"
				role="img"
				aria-label="trigger setup failed"
				title={tooltip}
			>
				<span class="entry-meta-label">trigger setup failed</span>
			</span>
		);
	}
	if (row.syntheticKind === "trigger.rejection") {
		const title = row.rejectionSummary
			? `trigger rejected: ${row.rejectionSummary}`
			: "trigger rejected";
		return (
			<span
				class="entry-meta-cell entry-rejected"
				role="img"
				aria-label="trigger rejected"
				title={title}
			>
				<span class="entry-meta-label">trigger rejected</span>
			</span>
		);
	}
	if (row.exhaustion) {
		return (
			<span class="entry-meta-cell">
				<ExhaustionPill exhaustion={row.exhaustion} />
			</span>
		);
	}
	if (row.dispatch?.source === "manual") {
		const tooltip = row.dispatch.user?.login ?? "manual";
		return (
			<span
				class="entry-meta-cell entry-dispatch entry-dispatch--manual"
				title={tooltip}
				role="img"
				aria-label="manual dispatch"
			>
				<ManualIcon class="icon" />
			</span>
		);
	}
	if (row.dispatch?.source === "upload") {
		const login = row.dispatch.user?.login ?? "";
		const mail = row.dispatch.user?.mail ?? "";
		const tooltip = mail ? `${login} <${mail}>` : login;
		return (
			<span
				class="entry-meta-cell entry-dispatch entry-dispatch--upload"
				title={tooltip}
				role="img"
				aria-label="uploaded"
			/>
		);
	}
	return <span class="entry-meta-cell" />;
}

function LeadingKindIcon({ row }: { row: InvocationRow }) {
	if (!row.triggerKind) {
		return <span class="trigger-kind-icon" aria-hidden="true" />;
	}
	if (row.syntheticKind === "system.upload") {
		const title = row.uploadShaShort
			? `workflow uploaded sha=${row.uploadShaShort}`
			: "workflow uploaded";
		return (
			<TriggerKindIcon
				kind={row.triggerKind}
				title={title}
				label="workflow uploaded"
			/>
		);
	}
	return <TriggerKindIcon kind={row.triggerKind} />;
}

function Identity({ row }: { row: InvocationRow }) {
	// Upload rows show repo › workflow only (no trigger leg).
	if (row.syntheticKind === "system.upload") {
		return (
			<span class="entry-identity">
				<span class="entry-scope">{`${row.owner}/${row.repo}`}</span>
				<span class="entry-identity-sep">›</span>
				<span class="entry-workflow">{row.workflow}</span>
			</span>
		);
	}
	return (
		<span class="entry-identity">
			<span class="entry-scope">{`${row.owner}/${row.repo}`}</span>
			<span class="entry-identity-sep">›</span>
			<span class="entry-workflow">{row.workflow}</span>
			<span class="entry-identity-sep">›</span>
			<span class="entry-trigger">{row.trigger}</span>
		</span>
	);
}

function StatusClass(row: InvocationRow): string {
	if (row.syntheticKind === "system.upload") {
		return "s-upload";
	}
	if (row.status === "succeeded") {
		return "s-succeeded";
	}
	if (row.status === "failed") {
		return "s-failed";
	}
	if (row.status === "pending") {
		return "s-pending";
	}
	return "";
}

function RowCells({
	row,
	expandable,
}: {
	row: InvocationRow;
	expandable: boolean;
}) {
	const duration =
		row.completedTs === null
			? "—"
			: formatDurationUs(row.completedTs - row.startedTs);
	const startedIso = toIsoString(row.startedAt);
	return (
		<>
			{expandable ? (
				<span class="entry-expand-chevron" aria-hidden="true">
					<ChevronIcon />
				</span>
			) : (
				<span
					class="entry-expand-chevron entry-expand-chevron--placeholder"
					aria-hidden="true"
				/>
			)}
			<LeadingKindIcon row={row} />
			<Identity row={row} />
			<MetaCell row={row} />
			<span class="entry-duration">{duration}</span>
			<time
				class="entry-age"
				datetime={startedIso}
				title={startedIso}
				data-relative="true"
			/>
		</>
	);
}

function Row({ row }: { row: InvocationRow }) {
	const noFlamegraph =
		row.status === "pending" ||
		row.syntheticKind === "trigger.rejection" ||
		row.syntheticKind === "trigger.exception" ||
		row.syntheticKind === "system.upload";
	const statusCls = StatusClass(row);
	if (noFlamegraph) {
		return (
			<div class={`entry ${statusCls}`} id={`inv-${row.id}`}>
				<RowCells row={row} expandable={false} />
			</div>
		);
	}
	const flamegraphUrl = `/invocations/${row.owner}/${row.repo}/${row.id}/flamegraph`;
	return (
		<details
			class={`entry entry-expandable ${statusCls}`}
			id={`inv-${row.id}`}
			hx-get={flamegraphUrl}
			hx-trigger="toggle once"
			hx-target="find .flame-slot"
			hx-swap="innerHTML"
		>
			<summary class="entry-summary" aria-label="Expand invocation details">
				<RowCells row={row} expandable={true} />
			</summary>
			<div class="flame-slot" />
		</details>
	);
}

function InvocationList({
	invocations,
}: {
	invocations: readonly InvocationRow[];
}) {
	if (invocations.length === 0) {
		return (
			<div class="empty-state" data-count="0">
				No invocations yet
			</div>
		);
	}
	const sorted = sortInvocationRows(invocations);
	const count = sorted.length;
	return (
		<div data-count={String(count)}>
			<div class="entry-table">
				<div class="entry-thead">
					<span aria-hidden="true" />
					<span aria-hidden="true" />
					<span class="entry-thead-cell">repo · workflow · trigger</span>
					<span aria-hidden="true" />
					<span class="entry-thead-cell entry-thead-cell--right">duration</span>
					<span class="entry-thead-cell entry-thead-cell--right">age</span>
				</div>
				{sorted.map((row) => (
					<Row row={row} />
				))}
			</div>
		</div>
	);
}

function renderInvocationList(invocations: readonly InvocationRow[]) {
	return (<InvocationList invocations={invocations} />).toString();
}

interface InvocationsPageOptions {
	readonly user: string;
	readonly email: string;
	readonly owners: readonly string[];
	readonly rows: readonly InvocationRow[];
	readonly sidebarTree?: Child;
	readonly tabs?: Child;
}

function InvocationsPage({
	user,
	email,
	rows,
	sidebarTree,
	tabs,
}: InvocationsPageOptions) {
	return (
		<Layout
			title="Invocations"
			activePath="/invocations"
			user={user}
			email={email}
			{...(sidebarTree === undefined ? {} : { sidebarTree })}
			{...(tabs === undefined ? {} : { tabs })}
		>
			<div class="list">
				<InvocationList invocations={rows} />
			</div>
		</Layout>
	);
}

function renderInvocationsPage(options: InvocationsPageOptions) {
	return (<InvocationsPage {...options} />).toString();
}

export type { InvocationRow, InvocationsPageOptions };
export {
	formatDurationUs,
	InvocationList,
	InvocationsPage,
	renderInvocationList,
	renderInvocationsPage,
	sortInvocationRows,
};
