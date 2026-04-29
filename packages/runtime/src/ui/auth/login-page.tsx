import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { FlashPayload } from "../../auth/flash-cookie.js";
import type { LoginSection } from "../../auth/providers/index.js";

interface BannerContent {
	readonly title: string;
	readonly role: "alert" | "status";
	readonly heading: string;
	readonly body: Child;
}

function bannerFor(flash: FlashPayload): BannerContent {
	if (flash.kind === "denied") {
		return {
			title: "Not authorized",
			role: "alert",
			heading: "Not authorized.",
			body: (
				<>
					You signed in as <code>{flash.login}</code>, but this instance does
					not grant you access. Contact the administrator if you believe this is
					an error. To try a different account,{" "}
					<a
						href="https://github.com/logout"
						target="_blank"
						rel="noopener noreferrer"
					>
						sign out of GitHub
					</a>{" "}
					first.
				</>
			),
		};
	}
	return {
		title: "Signed out",
		role: "status",
		heading: "Signed out.",
		body: <>You have been signed out of this instance.</>,
	};
}

interface LoginPageProps {
	readonly flash: FlashPayload | undefined;
	readonly returnTo: string;
	readonly sections: readonly LoginSection[];
}

function LoginPage({ flash, sections }: LoginPageProps) {
	const banner = flash ? bannerFor(flash) : undefined;
	const title = banner?.title ?? "Sign in";
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
				<body class="auth-page">
					<main class="auth-card">
						<h1 class="auth-card__title">
							Sign in to <span class="auth-card__brand">Workflow Engine</span>
						</h1>
						{banner ? (
							<div class="auth-card__banner" role={banner.role}>
								<strong>{banner.heading}</strong>
								{banner.body}
							</div>
						) : null}
						<div class="auth-card__actions">{sections}</div>
					</main>
				</body>
			</html>
		</>
	);
}

// Compat shim — calls .toString() so c.html() accepts the result directly.
function renderLoginPage(props: LoginPageProps) {
	return (<LoginPage {...props} />).toString();
}

export type { LoginPageProps };
export { LoginPage, renderLoginPage };
