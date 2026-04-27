import type { HttpCapture, MailCapture, SqlCapture } from "../types.js";
import { createHttpEchoMock, type HttpEchoConn } from "./http-echo.js";
import { createMockServer } from "./mock-server.js";
import { createPgMock, type PgConn } from "./pg.js";
import { createSmtpMock, type SmtpConn } from "./smtp.js";
import type { MockHandle } from "./types.js";

interface ProvidedMocks {
	echo: {
		// Connection URL handed to the spawned runtime as `MOCK_HTTP_URL`.
		url: string;
		// Admin URL the worker-side MockClient talks to.
		adminUrl: string;
	};
	smtp: {
		// SMTP transport coordinates handed to the spawned runtime so the
		// mail plugin's `nodemailer` transport connects to this catcher.
		host: string;
		port: number;
		// Random per-suite credentials; the catcher rejects any other.
		user: string;
		pass: string;
		// Admin URL the worker-side MockClient<MailCapture> talks to.
		adminUrl: string;
	};
	pg: {
		// Postgres DSN handed to the spawned runtime; loopback by design.
		url: string;
		// Self-signed CA PEM the workflow author hands to `executeSql` so
		// the TLS handshake against the embedded cluster verifies cleanly.
		ca: string;
		// Admin URL the worker-side MockClient<SqlCapture> talks to.
		adminUrl: string;
	};
}

interface MockSuite {
	provided: ProvidedMocks;
	stop(): Promise<void>;
}

async function startMockSuite(): Promise<MockSuite> {
	const echoHandle: MockHandle<HttpCapture, HttpEchoConn> =
		await createMockServer(createHttpEchoMock());
	const smtpHandle: MockHandle<MailCapture, SmtpConn> = await createMockServer(
		createSmtpMock(),
	);
	const pgHandle: MockHandle<SqlCapture, PgConn> = await createMockServer(
		createPgMock(),
	);
	return {
		provided: {
			echo: { url: echoHandle.conn.url, adminUrl: echoHandle.adminUrl },
			smtp: {
				host: smtpHandle.conn.host,
				port: smtpHandle.conn.port,
				user: smtpHandle.conn.user,
				pass: smtpHandle.conn.pass,
				adminUrl: smtpHandle.adminUrl,
			},
			pg: {
				url: pgHandle.conn.url,
				ca: pgHandle.conn.ca,
				adminUrl: pgHandle.adminUrl,
			},
		},
		async stop() {
			await echoHandle.stop();
			await smtpHandle.stop();
			await pgHandle.stop();
		},
	};
}

export type { MockSuite, ProvidedMocks };
export { startMockSuite };
