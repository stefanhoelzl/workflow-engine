// Shared icon components used by <Layout>, <SidebarTree>, and other UI
// surfaces. Each icon is a tiny sync component returning a single <svg>
// (lucide-style stroke icons) or a single <span> (unicode-glyph-based
// trigger-kind icons). Centralising them here keeps the icon registry in
// one place and lets every consumer use plain JSX (<DashboardIcon/>) instead
// of reaching for raw('<svg .../>') string constants.
//
// Every icon is decorative; aria-hidden="true" is set inline (not via spread)
// so Biome's noSvgWithoutTitle rule sees it.

// activity — dashboard
function DashboardIcon({ class: cls = "icon" }: { class?: string } = {}) {
	return (
		<svg
			class={cls}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M22 12h-4l-3 9L9 3l-3 9H2" />
		</svg>
	);
}

// zap — trigger
function TriggerIcon({ class: cls = "icon" }: { class?: string } = {}) {
	return (
		<svg
			class={cls}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
		</svg>
	);
}

// workflow — brand mark (small rounded-square "W"-ish glyph)
function BrandIcon({ class: cls = "icon" }: { class?: string } = {}) {
	return (
		<svg
			class={cls}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
		</svg>
	);
}

// chevron-right — shared expand affordance. Sized smaller (14×14) for
// inline use in the sidebar tree.
function ChevronIcon({ class: cls = "icon" }: { class?: string } = {}) {
	return (
		<svg
			class={cls}
			viewBox="0 0 24 24"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}

// Unicode-glyph trigger-kind icons. Replaces the host-side
// `triggerKindIcon(kind)` function from `triggers.ts`. The dashboard list,
// flamegraph header, sidebar leaves, and trigger card all consume this.
const KIND_GLYPHS: Record<string, string> = {
	http: "\u{1F310}", // globe
	cron: "\u{23F0}", // alarm clock
	manual: "\u{1F464}", // bust in silhouette
	imap: "\u{1F4E8}", // incoming envelope
};

function TriggerKindIcon({ kind }: { kind: string }) {
	const glyph = KIND_GLYPHS[kind] ?? "\u{25CF}";
	return (
		<span class="trigger-kind-icon" role="img" title={kind} aria-label={kind}>
			{glyph}
		</span>
	);
}

export { BrandIcon, ChevronIcon, DashboardIcon, TriggerIcon, TriggerKindIcon };
