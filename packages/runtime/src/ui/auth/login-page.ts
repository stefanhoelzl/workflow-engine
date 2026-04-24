import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { FlashPayload } from "../../auth/flash-cookie.js";
import type { LoginSection } from "../../auth/providers/index.js";

interface BannerContent {
	readonly title: string;
	readonly role: "alert" | "status";
	readonly heading: string;
	readonly bodyBase: HtmlEscapedString | Promise<HtmlEscapedString>;
}

function bannerFor(flash: FlashPayload): BannerContent {
	if (flash.kind === "denied") {
		return {
			title: "Not authorized",
			role: "alert",
			heading: "Not authorized.",
			bodyBase: html`You signed in as <code>${flash.login}</code>, but
      this instance does not grant you access. Contact the administrator
      if you believe this is an error. To try a different account,
      <a href="https://github.com/logout" target="_blank"
         rel="noopener noreferrer">sign out of GitHub</a> first.`,
		};
	}
	return {
		title: "Signed out",
		role: "status",
		heading: "Signed out.",
		bodyBase: html`You have been signed out of this instance.`,
	};
}

interface LoginPageProps {
	readonly flash: FlashPayload | undefined;
	readonly returnTo: string;
	readonly sections: readonly LoginSection[];
}

function renderLoginPage(
	props: LoginPageProps,
): HtmlEscapedString | Promise<HtmlEscapedString> {
	const banner = props.flash ? bannerFor(props.flash) : undefined;
	const title = banner?.title ?? "Sign in";
	return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="/static/workflow-engine.css">
</head>
<body class="auth-page">
  <main class="auth-card">
    <div class="auth-card__brand">
      <span class="auth-card__brand-icon">W</span>
      <span class="auth-card__brand-text">Workflow Engine</span>
    </div>
    ${
			banner
				? html`<div class="auth-card__banner" role="${banner.role}">
      <strong>${banner.heading}</strong>
      ${banner.bodyBase}
    </div>`
				: ""
		}
    <div class="auth-card__actions">
      ${props.sections}
    </div>
  </main>
</body>
</html>`;
}

export type { LoginPageProps };
export { renderLoginPage };
