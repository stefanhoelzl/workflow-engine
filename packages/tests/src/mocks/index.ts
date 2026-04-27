import type { HttpCapture, MailCapture } from "../types.js";
import { createHttpEchoMock, type HttpEchoConn } from "./http-echo.js";
import { createMockServer } from "./mock-server.js";
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
		},
		async stop() {
			await echoHandle.stop();
			await smtpHandle.stop();
		},
	};
}

export type { MockSuite, ProvidedMocks };
export { startMockSuite };
