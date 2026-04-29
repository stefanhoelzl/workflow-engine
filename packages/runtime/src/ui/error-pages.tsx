import { raw } from "hono/html";
import { TopBar } from "./icons.js";

// Error pages — rendered per-request via c.html(<NotFoundPage/>) /
// c.html(<ErrorPage/>) by the global notFound / onError handlers.
//
// Per `ui-foundation` "Universal topbar" + `ui-errors` page-outcome
// requirements: error pages render the same topbar as authenticated
// surfaces. User identity appears iff the request resolved a session;
// otherwise the topbar shows the brand wordmark only. No defensive
// try-catch on session resolution — if c.get("user") is undefined for
// any reason, the topbar simply renders without a user section.

interface ErrorShellProps {
	readonly title: string;
	readonly heading: string;
	readonly message: string;
	readonly linkText: string;
	readonly linkHref: string;
	readonly bodyClass: string;
	readonly user?: string;
	readonly email?: string;
}

function ErrorShell({
	title,
	heading,
	message,
	linkText,
	linkHref,
	bodyClass,
	user,
	email,
}: ErrorShellProps) {
	const topBarProps: { user?: string; email?: string } = {};
	if (user !== undefined) {
		topBarProps.user = user;
	}
	if (email !== undefined) {
		topBarProps.email = email;
	}
	return (
		<>
			{raw("<!DOCTYPE html>")}
			<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta
						name="viewport"
						content="width=device-width, initial-scale=1.0"
					/>
					<title>{title}</title>
					<link rel="stylesheet" href="/static/workflow-engine.css" />
				</head>
				<body class={bodyClass}>
					<TopBar {...topBarProps} />
					<div class="error-content">
						<div class="error-card">
							<div class="error-title">{heading}</div>
							<p class="error-message">{message}</p>
							<a href={linkHref} class="error-link">
								{linkText}
							</a>
						</div>
					</div>
				</body>
			</html>
		</>
	);
}

interface ErrorPageProps {
	readonly user?: string;
	readonly email?: string;
}

function NotFoundPage({ user, email }: ErrorPageProps = {}) {
	const userProps: { user?: string; email?: string } = {};
	if (user !== undefined) {
		userProps.user = user;
	}
	if (email !== undefined) {
		userProps.email = email;
	}
	return (
		<ErrorShell
			title="Not Found - Workflow Engine"
			heading="Page not found"
			message="The page you're looking for doesn't exist."
			linkText="Go to dashboard"
			linkHref="/dashboard/"
			bodyClass="error-page"
			{...userProps}
		/>
	);
}

function ErrorPage({ user, email }: ErrorPageProps = {}) {
	const userProps: { user?: string; email?: string } = {};
	if (user !== undefined) {
		userProps.user = user;
	}
	if (email !== undefined) {
		userProps.email = email;
	}
	return (
		<ErrorShell
			title="Error - Workflow Engine"
			heading="Something went wrong"
			message="The server encountered an error. Try again in a few moments."
			linkText="Go home"
			linkHref="/"
			bodyClass="error-page"
			{...userProps}
		/>
	);
}

export type { ErrorPageProps };
export { ErrorPage, NotFoundPage };
