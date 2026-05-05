import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:8080";

const browser = await chromium.launch();
const ctx = await browser.newContext({
	viewport: { width: 1600, height: 900 },
});
const page = await ctx.newPage();

await ctx.request.post(`${BASE}/auth/local/signin`, {
	form: { user: "local-user" },
	maxRedirects: 0,
});

// Find a non-trivial invocation by scraping the invocations index.
const idx = await ctx.request.get(`${BASE}/invocations`);
const idxHtml = await idx.text();
const candidates = [
	...idxHtml.matchAll(
		/\/invocations\/local-user\/(another-repo|demo-repo)\/(evt_[a-f0-9-]+)\/flamegraph/g,
	),
].map((m) => ({ repo: m[1], id: m[2] }));

// Pick the first invocation whose flamegraph has > 5 bars.
let chosen = null;
for (const c of candidates) {
	const r = await ctx.request.get(
		`${BASE}/invocations/local-user/${c.repo}/${c.id}/flamegraph`,
	);
	const t = await r.text();
	const bars = (t.match(/<rect class="flame-bar/g) || []).length;
	if (bars > 5) {
		chosen = { ...c, html: t, bars };
		break;
	}
}
if (!chosen) {
	console.error("no rich invocation found");
	process.exit(1);
}
console.log(`chosen: ${chosen.repo}/${chosen.id} (${chosen.bars} bars)`);

const wrapper = `<!doctype html><html><head>
<link rel="stylesheet" href="${BASE}/static/workflow-engine.css">
<style>body{margin:0;background:#0a0a0a;color:#fff;font-family:sans-serif}</style>
</head><body>${chosen.html}
<script src="${BASE}/static/flamegraph.js"></script>
</body></html>`;

await page.setContent(wrapper, { waitUntil: "networkidle" });
await page.waitForSelector(".flame-graph", { timeout: 5000 });

await page.locator(".flame-container").first().screenshot({ path: "/tmp/flame.png" });
console.log("saved /tmp/flame.png (zoom 100%)");

for (const z of [200, 500, 800, 1500, 10000, 100000]) {
	await page.evaluate((zoom) => {
		const c = document.querySelector(".flame-container");
		// Drive through applyZoom so the ruler refreshes (real users always
		// hit this path via ctrl+wheel).
		if (c && typeof window.__flameApplyZoom === "function") {
			window.__flameApplyZoom(c, zoom);
		}
	}, z);
	await page.waitForTimeout(200);
	await page
		.locator(".flame-container")
		.first()
		.screenshot({ path: `/tmp/flame-z${z}.png` });
	console.log(`saved /tmp/flame-z${z}.png`);
}

// Cursor-anchored zoom test: dispatch ctrl+wheel events at a fixed cursor
// position and assert the timestamp under the cursor stays put across the
// zoom burst.
await page.evaluate(() => {
	const c = document.querySelector(".flame-container");
	if (c && typeof window.__flameApplyZoom === "function") {
		window.__flameApplyZoom(c, 100);
		c.scrollLeft = 0;
	}
});

const result = await page.evaluate(() => {
	const c = document.querySelector(".flame-container");
	const canvas = c.querySelector(".flame-canvas");
	const totalTs = Number(c.querySelector(".flame-ruler").dataset.totalTs);
	const rect = c.getBoundingClientRect();
	// Cursor at 600px from container's left edge.
	const cursorViewportX = 600;
	const tsAt = (cw, sl) =>
		((sl + cursorViewportX) / cw) * totalTs;
	const before = {
		zoom: 100,
		canvasW: canvas.getBoundingClientRect().width,
		scrollL: c.scrollLeft,
	};
	const tsBefore = tsAt(before.canvasW, before.scrollL);
	// Burst of zoom-in wheel events at cursor X = rect.left + 600.
	for (let i = 0; i < 10; i++) {
		c.dispatchEvent(
			new WheelEvent("wheel", {
				ctrlKey: true,
				deltaY: -100,
				clientX: rect.left + cursorViewportX,
				clientY: rect.top + 50,
				bubbles: true,
				cancelable: true,
			}),
		);
	}
	const after = {
		zoom: Number(c.getAttribute("data-flame-zoom")),
		canvasW: canvas.getBoundingClientRect().width,
		scrollL: c.scrollLeft,
	};
	const tsAfter = tsAt(after.canvasW, after.scrollL);
	return { before, after, tsBefore, tsAfter, totalTs };
});
console.log("cursor-zoom anchor test:");
console.log("  before:", result.before, "→ ts=", result.tsBefore);
console.log("  after: ", result.after, "→ ts=", result.tsAfter);
console.log(
	"  drift:",
	Math.abs(result.tsAfter - result.tsBefore),
	"µs (should be ≪ totalTs =",
	result.totalTs,
	"µs)",
);

await browser.close();
