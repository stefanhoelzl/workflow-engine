import { vi } from "vitest";
import type { Logger } from "../logger.js";

// A no-op `Logger` whose methods are all `vi.fn()`s. Tests that need to
// assert against log output should still use vi.fn() spies directly; this
// helper covers the common case where a constructor takes a `logger` and
// the test simply doesn't care about the lines.
function createTestLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger;
}

export { createTestLogger };
