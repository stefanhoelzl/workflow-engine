import type { HttpCapture } from "../types.js";
import { createHttpEchoMock, type HttpEchoConn } from "./http-echo.js";
import { createMockServer } from "./mock-server.js";
import type { MockHandle } from "./types.js";

interface ProvidedMocks {
	echo: {
		// Connection URL handed to the spawned runtime as `MOCK_HTTP_URL`.
		url: string;
		// Admin URL the worker-side MockClient talks to.
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
	return {
		provided: {
			echo: { url: echoHandle.conn.url, adminUrl: echoHandle.adminUrl },
		},
		async stop() {
			await echoHandle.stop();
		},
	};
}

export type { MockSuite, ProvidedMocks };
export { startMockSuite };
