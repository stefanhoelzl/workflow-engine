import { inject } from "vitest";
import "./mocks/provided.js";

interface EchoApi {
	// Plain mock origin (`http://127.0.0.1:<port>`) — runtime-facing.
	readonly url: string;
	// Admin-protocol origin — `MockClient` consumers talk to this.
	readonly adminUrl: string;
	// Build a URL the spawned runtime fetches that, if it ever reached the
	// echo mock, would land in the slug bucket. Encapsulates the mock's
	// "first path segment is slug" convention so tests don't hand-concat.
	urlFor(slug: string, ...path: string[]): string;
}

interface SmtpApi {
	// SMTP coordinates the spawned runtime hands to nodemailer. The mock
	// uses plain (non-TLS) sockets; the matching mail-plugin option is
	// `tls: "plaintext"`.
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly pass: string;
	readonly adminUrl: string;
	// Recipient address that carries the slug in its plus-address. The
	// catcher derives the slug back from `dest+<slug>@test`, so test-side
	// `state.smtp.captures({slug})` filters cleanly.
	recipient(slug: string): string;
}

interface PgApi {
	// Postgres DSN handed to the spawned runtime as workflow env. Loopback
	// by design — tests must set `WFE_TEST_DISABLE_SSRF_PROTECTION=true`
	// (via `describe({env: …})`) to let the SQL plugin reach it.
	readonly url: string;
	// Self-signed CA PEM the workflow author passes to `executeSql` so
	// the TLS handshake verifies against the bundled cert.
	readonly ca: string;
	readonly adminUrl: string;
}

interface MocksApi {
	readonly echo: EchoApi;
	readonly smtp: SmtpApi;
	readonly pg: PgApi;
}

function getMocks(): MocksApi {
	const provided = inject("mocks");
	const url = provided.echo.url;
	return {
		echo: {
			url,
			adminUrl: provided.echo.adminUrl,
			urlFor(slug, ...path) {
				const tail = path.length === 0 ? "" : `/${path.join("/")}`;
				return `${url}/${slug}${tail}`;
			},
		},
		smtp: {
			host: provided.smtp.host,
			port: provided.smtp.port,
			user: provided.smtp.user,
			pass: provided.smtp.pass,
			adminUrl: provided.smtp.adminUrl,
			recipient(slug) {
				return `dest+${slug}@test`;
			},
		},
		pg: {
			url: provided.pg.url,
			ca: provided.pg.ca,
			adminUrl: provided.pg.adminUrl,
		},
	};
}

export type { EchoApi, MocksApi, PgApi, SmtpApi };
export { getMocks };
