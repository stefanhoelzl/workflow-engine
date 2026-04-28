import { raw } from "hono/html";

// Error pages — rendered per-request via c.html(<NotFoundPage/>) /
// c.html(<ErrorPage/>) by the global notFound / onError handlers.
//
// Visible content matches the previous static `static/404.html` and
// `static/error.html` exactly: minimal topbar with brand only (no user
// identity, no sidebar, no Alpine/htmx scripts), centered error card with
// title/message/link. The "delivered the same way as other pages"
// requirement (c.html() through the JSX path) is satisfied without
// pulling in the full <Layout> chrome — error pages remain a separate
// visual category, anonymous by construction.

interface ErrorShellProps {
	readonly title: string;
	readonly heading: string;
	readonly message: string;
	readonly linkText: string;
	readonly linkHref: string;
	readonly bodyClass: string;
}

function ErrorShell({
	title,
	heading,
	message,
	linkText,
	linkHref,
	bodyClass,
}: ErrorShellProps) {
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
					<div class="topbar">
						<div class="topbar-brand">
							<span class="icon">W</span>
							<span>Workflow Engine</span>
						</div>
					</div>

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

function NotFoundPage() {
	return (
		<ErrorShell
			title="Not Found - Workflow Engine"
			heading="Page not found"
			message="The page you're looking for doesn't exist."
			linkText="Go to dashboard"
			linkHref="/dashboard/"
			bodyClass="error-page"
		/>
	);
}

function ErrorPage() {
	return (
		<ErrorShell
			title="Error - Workflow Engine"
			heading="Something went wrong"
			message="The server encountered an error. Try again in a few moments."
			linkText="Go home"
			linkHref="/"
			bodyClass="error-page"
		/>
	);
}

export { ErrorPage, NotFoundPage };
