import { pinoLogger } from "hono-pino";
import pino from "pino";

type LogLevel =
	| "trace"
	| "debug"
	| "info"
	| "warn"
	| "error"
	| "fatal"
	| "silent";

interface Logger {
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
	error(msg: string, data?: Record<string, unknown>): void;
	debug(msg: string, data?: Record<string, unknown>): void;
	trace(msg: string, data?: Record<string, unknown>): void;
	child(bindings: Record<string, unknown>): Logger;
}

class PinoLogger implements Logger {
	readonly #pino: pino.Logger;

	constructor(instance: pino.Logger) {
		this.#pino = instance;
	}

	info(msg: string, data?: Record<string, unknown>): void {
		if (data) {
			this.#pino.info(data, msg);
		} else {
			this.#pino.info(msg);
		}
	}

	warn(msg: string, data?: Record<string, unknown>): void {
		if (data) {
			this.#pino.warn(data, msg);
		} else {
			this.#pino.warn(msg);
		}
	}

	error(msg: string, data?: Record<string, unknown>): void {
		if (data) {
			this.#pino.error(data, msg);
		} else {
			this.#pino.error(msg);
		}
	}

	debug(msg: string, data?: Record<string, unknown>): void {
		if (data) {
			this.#pino.debug(data, msg);
		} else {
			this.#pino.debug(msg);
		}
	}

	trace(msg: string, data?: Record<string, unknown>): void {
		if (data) {
			this.#pino.trace(data, msg);
		} else {
			this.#pino.trace(msg);
		}
	}

	child(bindings: Record<string, unknown>): Logger {
		return new PinoLogger(this.#pino.child(bindings));
	}
}

interface LoggerOptions {
	level?: LogLevel;
	destination?: NodeJS.WritableStream;
}

function createLogger(name: string, options?: LoggerOptions): Logger {
	const instance = options?.destination
		? pino({ name, level: options.level ?? "info" }, options.destination)
		: pino({ name, level: options?.level ?? "info" });
	return new PinoLogger(instance);
}

function createHttpLogger(
	name: string,
	options?: LoggerOptions,
): { match: string; handler: ReturnType<typeof pinoLogger> } {
	const instance = options?.destination
		? pino({ name, level: options.level ?? "info" }, options.destination)
		: pino({ name, level: options?.level ?? "info" });
	return { match: "*", handler: pinoLogger({ pino: instance }) };
}

export { createHttpLogger, createLogger, type Logger, type LogLevel };
