import { type Mock, vi } from "vitest";
import type { Logger } from "../logger.js";

// A `Logger` whose methods are all `vi.fn()`s with their mock APIs preserved.
// Use `logger.warn.mock.calls` etc. to assert against logged messages without
// casts. `child()` returns the same logger so child-binding spies share state.
interface MockLogger extends Logger {
	readonly info: Mock<Logger["info"]>;
	readonly warn: Mock<Logger["warn"]>;
	readonly error: Mock<Logger["error"]>;
	readonly debug: Mock<Logger["debug"]>;
	readonly trace: Mock<Logger["trace"]>;
	readonly child: Mock<Logger["child"]>;
}

function createTestLogger(): MockLogger {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn(() => logger),
	} as unknown as MockLogger;
	return logger;
}

export type { MockLogger };
export { createTestLogger };
