// Shared icon + topbar components used across UI surfaces. Centralising
// these here keeps the icon registry in one place and lets every consumer
// use plain JSX (<DashboardIcon/>, <TriggerKindIcon kind="cron"/>) instead
// of reaching for raw('<svg .../>') string constants.
//
// Every icon is decorative; aria-hidden="true" is set inline (not via spread)
// so Biome's noSvgWithoutTitle rule sees it.
//
// Icon strokes use Lucide's design (1.6–2px, round caps, 24×24 viewBox),
// adapted to inherit currentColor. Cross-platform-stable per the
// `ui-foundation` "Icon rendering invariants" requirement (no emoji, no
// external icon-font fetch, no platform-emoji rendering).

import type { Child } from "hono/jsx";

interface IconProps {
	class?: string;
}

function Svg({
	class: cls = "icon",
	stroke = "2",
	width,
	height,
	children,
}: {
	class?: string;
	stroke?: string;
	width?: string;
	height?: string;
	children: unknown;
}) {
	return (
		<svg
			class={cls}
			viewBox="0 0 24 24"
			width={width}
			height={height}
			fill="none"
			stroke="currentColor"
			stroke-width={stroke}
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

// activity — dashboard nav
function DashboardIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls}>
			<path d="M22 12h-4l-3 9L9 3l-3 9H2" />
		</Svg>
	);
}

// zap — trigger nav
function TriggerIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls}>
			<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
		</Svg>
	);
}

// chevron-right — shared expand affordance, sized smaller (14×14) for
// inline use in the sidebar tree.
function ChevronIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} width="14" height="14">
			<path d="m9 18 6-6-6-6" />
		</Svg>
	);
}

// ---------------------------------------------------------------------------
// Trigger-kind icons (cross-platform-stable replacement for the old
// emoji glyphs). Each kind has a distinct Lucide-derived shape per the
// `ui-foundation` "Distinct visual indicator per trigger kind" requirement.
// ---------------------------------------------------------------------------

// clock — cron (Lucide: face circle + hour/minute hands)
function CronIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="2">
			<circle cx="12" cy="12" r="10" fill="none" />
			<polyline points="12 6 12 12 16 14" fill="none" />
		</Svg>
	);
}

// globe — http (Lucide: circle + equator + dual-arc longitude)
function HttpIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="2">
			<circle cx="12" cy="12" r="10" fill="none" />
			<path d="M2 12h20" fill="none" />
			<path d="M12 2a14.5 14.5 0 0 1 0 20 14.5 14.5 0 0 1 0-20" fill="none" />
		</Svg>
	);
}

// user — manual (was mouse-pointer-click; user prefers the person silhouette)
function ManualIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="2">
			<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" fill="none" />
			<circle cx="12" cy="7" r="4" fill="none" />
		</Svg>
	);
}

// mail — imap (Lucide envelope; explicit fill="none" so the rect doesn't
// inherit a stray fill from any nearby selector)
function ImapIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="2">
			<rect width="20" height="16" x="2" y="4" rx="2" fill="none" />
			<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" fill="none" />
		</Svg>
	);
}

// plug — ws (Lucide power-plug; signals bidirectional persistent connection)
function WsIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="2">
			<path d="M9 2v6" fill="none" />
			<path d="M15 2v6" fill="none" />
			<path d="M6 8h12v4a6 6 0 0 1-12 0z" fill="none" />
			<path d="M12 18v4" fill="none" />
		</Svg>
	);
}

function kindGlyph(kind: string): Child {
	switch (kind) {
		case "cron":
			return <CronIcon />;
		case "http":
			return <HttpIcon />;
		case "manual":
			return <ManualIcon />;
		case "imap":
			return <ImapIcon />;
		case "ws":
			return <WsIcon />;
		default:
			// Unknown kind — neutral dot so layout stays stable without leaking
			// emoji or `?` glyphs. Author-visible only when a new kind is
			// registered without a matching icon (implementation gap).
			return (
				<Svg stroke="1.8">
					<circle cx="12" cy="12" r="4" />
				</Svg>
			);
	}
}

function TriggerKindIcon({ kind }: { kind: string }) {
	const cls = `trigger-kind-icon trigger-kind-icon--${kind}`;
	return (
		<span class={cls} role="img" title={kind} aria-label={kind}>
			{kindGlyph(kind)}
		</span>
	);
}

// ---------------------------------------------------------------------------
// Event-prefix icons — leftmost row gutter on the dashboard list and event
// log, plus flamegraph slice indicators. Distinct shape per top-level prefix
// per the `ui-foundation` "Distinct visual indicator per event prefix"
// requirement. Colour comes from the parent's currentColor (see the
// `--kind-trigger` / `--kind-action` / `--kind-rest` tokens).
// ---------------------------------------------------------------------------

// zap — trigger.* events
function TriggerPrefixIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="1.8">
			<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
		</Svg>
	);
}

// box — action.* events
function ActionPrefixIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="1.8">
			<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
			<path d="m3.3 7 8.7 5 8.7-5" />
			<path d="M12 22V12" />
		</Svg>
	);
}

// terminal — system.* events
function SystemPrefixIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} stroke="1.8">
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</Svg>
	);
}

function prefixGlyph(prefix: string): Child {
	switch (prefix) {
		case "trigger":
			return <TriggerPrefixIcon />;
		case "action":
			return <ActionPrefixIcon />;
		case "system":
			return <SystemPrefixIcon />;
		default:
			return (
				<Svg stroke="1.8">
					<circle cx="12" cy="12" r="4" />
				</Svg>
			);
	}
}

function EventPrefixIcon({ prefix }: { prefix: string }) {
	const cls = `row-icon row-icon--${prefix}`;
	return (
		<span class={cls} aria-hidden="true">
			{prefixGlyph(prefix)}
		</span>
	);
}

// github mark — auth provider button (filled, sits on a dark surface so
// fill is intentional here; the rest of the icon set is stroke-only).
function GithubIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<svg class={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.16-.01-2.11-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.73-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.91-.25 1.89-.38 2.86-.39.97.01 1.95.13 2.87.39 2.18-1.49 3.14-1.18 3.14-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.66.79.55C20.21 21.39 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z" />
		</svg>
	);
}

// chevron-down — dropdown affordance, sized 14×14 to sit beside button text.
function ChevronDownIcon({ class: cls = "icon" }: IconProps = {}) {
	return (
		<Svg class={cls} width="14" height="14">
			<path d="m6 9 6 6 6-6" />
		</Svg>
	);
}

// ---------------------------------------------------------------------------
// Universal topbar — used by <Layout/> (authenticated surfaces), the login
// page, and the error pages. Renders the brand wordmark always; renders the
// user section iff `user` is supplied. Per `ui-foundation` "Universal
// topbar" requirement.
// ---------------------------------------------------------------------------

interface TopBarProps {
	user?: string;
	email?: string;
}

function TopBar({ user, email }: TopBarProps = {}) {
	return (
		<div class="topbar">
			<div class="topbar-brand">Workflow Engine</div>
			{user ? (
				<div class="topbar-right">
					<section class="topbar-user" aria-label={`Signed in as ${user}`}>
						<div class="topbar-user-line">
							<span class="topbar-username">{user}</span>
							<form
								class="topbar-signout-form"
								method="post"
								action="/auth/logout"
							>
								<button class="topbar-signout" type="submit">
									Sign out
								</button>
							</form>
						</div>
						{email ? <div class="topbar-email">{email}</div> : null}
					</section>
				</div>
			) : null}
		</div>
	);
}

export {
	ActionPrefixIcon,
	ChevronDownIcon,
	ChevronIcon,
	CronIcon,
	DashboardIcon,
	EventPrefixIcon,
	GithubIcon,
	HttpIcon,
	ImapIcon,
	ManualIcon,
	SystemPrefixIcon,
	TopBar,
	TriggerIcon,
	TriggerKindIcon,
	TriggerPrefixIcon,
};
