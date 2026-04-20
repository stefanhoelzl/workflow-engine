import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { FlashPayload } from "../../auth/flash-cookie.js";

interface BannerContent {
	readonly title: string;
	readonly role: "alert" | "status";
	readonly heading: string;
	readonly body: HtmlEscapedString | Promise<HtmlEscapedString>;
}

function bannerFor(flash: FlashPayload): BannerContent {
	if (flash.kind === "denied") {
		return {
			title: "Not authorized",
			role: "alert",
			heading: "Not authorized.",
			body: html`You signed in to GitHub as <code>${flash.login}</code>, but
      this instance does not grant you access. Contact the administrator
      if you believe this is an error.`,
		};
	}
	return {
		title: "Signed out",
		role: "status",
		heading: "Signed out.",
		body: html`You have been signed out of this instance. GitHub may
    still consider this browser signed in to your GitHub account —
    sign out of GitHub too if you want to fully end the session or
    switch accounts.`,
	};
}

interface LoginPageProps {
	readonly flash: FlashPayload | undefined;
	readonly returnTo: string;
}

function renderLoginPage(
	props: LoginPageProps,
): HtmlEscapedString | Promise<HtmlEscapedString> {
	const banner = props.flash ? bannerFor(props.flash) : undefined;
	const title = banner?.title ?? "Sign in";
	const signinHref = `/auth/github/signin?returnTo=${encodeURIComponent(props.returnTo)}`;
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
      ${banner.body}
    </div>`
				: ""
		}
    <div class="auth-card__actions">
      <a href="${signinHref}" class="btn btn--primary">Sign in with GitHub</a>
      ${
				banner
					? html`<a href="https://github.com/logout" class="btn btn--secondary"
         rel="noopener noreferrer" target="_blank">Sign out of GitHub</a>`
					: ""
			}
    </div>
  </main>
</body>
</html>`;
}

export type { LoginPageProps };
export { renderLoginPage };
