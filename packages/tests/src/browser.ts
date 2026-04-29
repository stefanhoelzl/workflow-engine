import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";

const BROWSER_LAUNCH_HARDCAP_MS = 30_000;

let cachedBrowser: Browser | null = null;
let cleanupRegistered = false;

async function getBrowser(): Promise<Browser> {
	if (cachedBrowser) {
		return cachedBrowser;
	}
	const browser = await chromium.launch({
		headless: true,
		timeout: BROWSER_LAUNCH_HARDCAP_MS,
	});
	cachedBrowser = browser;
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		// Worker process exits when its file batch finishes; closing the
		// browser here releases chromium without waiting for OS cleanup.
		process.on("beforeExit", () => {
			if (cachedBrowser) {
				const b = cachedBrowser;
				cachedBrowser = null;
				b.close().catch(() => undefined);
			}
		});
	}
	return browser;
}

interface RunBrowserStepArgs {
	baseUrl: string;
	run: (page: Page) => Promise<void>;
}

async function runBrowserStep(args: RunBrowserStepArgs): Promise<void> {
	const browser = await getBrowser();
	const context = await browser.newContext({ baseURL: args.baseUrl });
	try {
		const page = await context.newPage();
		await args.run(page);
	} finally {
		await context.close();
	}
}

async function loginViaForm(page: Page, user: string): Promise<void> {
	const returnTo = "/dashboard";
	await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
	await page.locator("details.auth-local > summary").click();
	await Promise.all([
		page.waitForURL(returnTo),
		page
			.locator(`button.auth-local__item[name="user"][value="${user}"]`)
			.click(),
	]);
}

export type { Page } from "@playwright/test";
export { loginViaForm, runBrowserStep };
