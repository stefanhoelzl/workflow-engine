import { describe, expect, it, vi } from "vitest";
import type { Logger } from "./index.js";
import { dispatchLog } from "./log-dispatch.js";

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

describe("dispatchLog", () => {
	it("routes the log message to the matching logger level with meta", () => {
		const logger = makeLogger();
		dispatchLog(logger, {
			type: "log",
			level: "debug",
			message: "quickjs.fd_write",
			meta: { fd: 2, text: "diag" },
		});
		expect(logger.debug).toHaveBeenCalledTimes(1);
		expect(logger.debug).toHaveBeenCalledWith("quickjs.fd_write", {
			fd: 2,
			text: "diag",
		});
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("silently drops the message when no logger is provided", () => {
		// Should not throw.
		dispatchLog(undefined, {
			type: "log",
			level: "error",
			message: "noise",
		});
	});

	it("swallows logger errors so a broken logger cannot kill the worker listener", () => {
		const logger: Logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(() => {
				throw new Error("logger exploded");
			}),
			debug: vi.fn(),
		};
		expect(() =>
			dispatchLog(logger, {
				type: "log",
				level: "error",
				message: "x",
			}),
		).not.toThrow();
	});
});
