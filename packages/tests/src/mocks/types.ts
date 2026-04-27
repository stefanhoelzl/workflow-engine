import type { MockCapture } from "../types.js";

// Internal mock implementation contract. Each mock is a small adapter:
// it owns its own protocol-level server (HTTP echo, SMTP, Postgres) and
// hands captured records to a recorder. The shared `createMockServer`
// wraps any `Mock` in a uniform admin HTTP layer.
interface Mock<TCapture extends MockCapture, TConn> {
	readonly name: string;
	start(record: (capture: TCapture) => void): Promise<TConn>;
	stop(): Promise<void>;
}

interface MockHandle<_TCapture extends MockCapture, TConn> {
	readonly conn: TConn;
	readonly adminUrl: string;
	stop(): Promise<void>;
}

export type { Mock, MockHandle };
