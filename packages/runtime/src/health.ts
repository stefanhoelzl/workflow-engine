import { constants } from "node:http2";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { EventStore } from "./event-bus/event-store.js";
import type { StorageBackend } from "./storage/index.js";
import type { Middleware } from "./triggers/http.js";

const CONTENT_TYPE = "application/health+json";
const DEFAULT_TIMEOUT_MS = 5000;

interface CheckResult {
	status: "pass" | "fail";
	componentType: string;
	observedValue?: number;
	observedUnit?: string;
	output?: string;
}

interface HealthResponse {
	status: "pass" | "fail";
	checks?: Record<string, CheckResult[]>;
}

interface HealthDeps {
	eventStore: EventStore;
	storageBackend: StorageBackend | undefined;
	baseUrl: string | undefined;
}

async function timed<T>(
	fn: () => Promise<T>,
	timeoutMs: number,
): Promise<{ durationMs: number; result: T }> {
	const start = performance.now();
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error(`timeout after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	const result = await Promise.race([fn(), timeout]);
	return { durationMs: Math.round(performance.now() - start), result };
}

function pass(componentType: string, durationMs: number): CheckResult {
	return {
		status: "pass",
		componentType,
		observedValue: durationMs,
		observedUnit: "ms",
	};
}

function fail(
	componentType: string,
	output: string,
	durationMs?: number,
): CheckResult {
	const result: CheckResult = { status: "fail", componentType, output };
	if (durationMs !== undefined) {
		result.observedValue = durationMs;
		result.observedUnit = "ms";
	}
	return result;
}

async function checkEventstore(
	deps: HealthDeps,
	timeoutMs: number,
): Promise<Record<string, CheckResult[]>> {
	try {
		const { durationMs } = await timed(
			() =>
				deps.eventStore.query
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.executeTakeFirstOrThrow(),
			timeoutMs,
		);
		return { eventstore: [pass("datastore", durationMs)] };
	} catch (err) {
		return {
			eventstore: [
				fail("datastore", err instanceof Error ? err.message : String(err)),
			],
		};
	}
}

async function checkPersistence(
	deps: HealthDeps,
	timeoutMs: number,
): Promise<Record<string, CheckResult[]>> {
	if (!deps.storageBackend) {
		const msg = "no backend configured";
		return {
			"persistence:write": [fail("datastore", msg)],
			"persistence:read": [fail("datastore", msg)],
			"persistence:list": [fail("datastore", msg)],
		};
	}

	const checks: Record<string, CheckResult[]> = {};
	const backend = deps.storageBackend;
	const sentinel = ".healthz/sentinel";
	const content = new Date().toISOString();

	try {
		const { durationMs } = await timed(
			() => backend.write(sentinel, content),
			timeoutMs,
		);
		checks["persistence:write"] = [pass("datastore", durationMs)];
	} catch (err) {
		checks["persistence:write"] = [
			fail("datastore", err instanceof Error ? err.message : String(err)),
		];
	}

	try {
		const { durationMs } = await timed(() => backend.read(sentinel), timeoutMs);
		checks["persistence:read"] = [pass("datastore", durationMs)];
	} catch (err) {
		checks["persistence:read"] = [
			fail("datastore", err instanceof Error ? err.message : String(err)),
		];
	}

	try {
		const { durationMs } = await timed(async () => {
			for await (const _entry of backend.list("pending/")) {
				// consume the iterator
			}
		}, timeoutMs);
		checks["persistence:list"] = [pass("datastore", durationMs)];
	} catch (err) {
		checks["persistence:list"] = [
			fail("datastore", err instanceof Error ? err.message : String(err)),
		];
	}

	return checks;
}

async function checkWebhooks(
	deps: HealthDeps,
	timeoutMs: number,
): Promise<Record<string, CheckResult[]>> {
	if (!deps.baseUrl) {
		return { webhooks: [fail("component", "BASE_URL not configured")] };
	}

	try {
		const { durationMs, result: res } = await timed(
			() =>
				fetch(`${deps.baseUrl}/webhooks/`, {
					signal: AbortSignal.timeout(timeoutMs),
				}),
			timeoutMs,
		);
		if (res.status === constants.HTTP_STATUS_NO_CONTENT) {
			return { webhooks: [pass("component", durationMs)] };
		}
		return {
			webhooks: [
				fail("component", `unexpected status ${res.status}`, durationMs),
			],
		};
	} catch (err) {
		return {
			webhooks: [
				fail("component", err instanceof Error ? err.message : String(err)),
			],
		};
	}
}

async function checkDomain(
	deps: HealthDeps,
	timeoutMs: number,
): Promise<Record<string, CheckResult[]>> {
	if (!deps.baseUrl) {
		return { domain: [fail("system", "BASE_URL not configured")] };
	}

	try {
		const { durationMs, result: res } = await timed(
			() =>
				fetch(`${deps.baseUrl}/healthz`, {
					signal: AbortSignal.timeout(timeoutMs),
				}),
			timeoutMs,
		);
		if (res.status !== constants.HTTP_STATUS_OK) {
			return {
				domain: [fail("system", `unexpected status ${res.status}`, durationMs)],
			};
		}
		const body = (await res.json()) as { status?: string };
		if (body.status !== "pass") {
			return {
				domain: [
					fail(
						"system",
						`unexpected response status "${body.status}"`,
						durationMs,
					),
				],
			};
		}
		return { domain: [pass("system", durationMs)] };
	} catch (err) {
		return {
			domain: [
				fail("system", err instanceof Error ? err.message : String(err)),
			],
		};
	}
}

type CheckFn = (
	deps: HealthDeps,
	timeoutMs: number,
) => Promise<Record<string, CheckResult[]>>;

const CHECK_MAP: Record<string, CheckFn> = {
	eventstore: checkEventstore,
	persistence: checkPersistence,
	domain: checkDomain,
	webhooks: checkWebhooks,
};

async function runChecks(
	deps: HealthDeps,
	checkNames: string[],
	timeoutMs: number,
): Promise<HealthResponse> {
	const allChecks: Record<string, CheckResult[]> = {};
	let hasFail = false;

	for (const name of checkNames) {
		const fn = CHECK_MAP[name];
		if (!fn) {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: sequential check execution by design
		const results = await fn(deps, timeoutMs);
		for (const [key, value] of Object.entries(results)) {
			allChecks[key] = value;
			if (value[0]?.status === "fail") {
				hasFail = true;
			}
		}
	}

	return {
		status: hasFail ? "fail" : "pass",
		checks: allChecks,
	};
}

function healthJson(c: Context, response: HealthResponse): Response {
	const status =
		response.status === "pass"
			? constants.HTTP_STATUS_OK
			: constants.HTTP_STATUS_SERVICE_UNAVAILABLE;
	return c.body(JSON.stringify(response), {
		status: status as ContentfulStatusCode,
		headers: { "Content-Type": CONTENT_TYPE },
	});
}

function healthMiddleware(deps: HealthDeps): Middleware {
	return {
		match: "/*",
		handler: async (c, next) => {
			const path = c.req.path;

			if (path === "/livez") {
				return healthJson(c, { status: "pass" });
			}

			if (path === "/healthz") {
				const requestedChecks = Object.keys(CHECK_MAP).filter(
					(name) => c.req.query(name) === "true",
				);

				if (requestedChecks.length === 0) {
					return healthJson(c, { status: "pass" });
				}

				const timeoutParam = c.req.query("timeout");
				const timeoutMs = timeoutParam
					? Number(timeoutParam)
					: DEFAULT_TIMEOUT_MS;
				return healthJson(c, await runChecks(deps, requestedChecks, timeoutMs));
			}

			if (path === "/readyz") {
				const allCheckNames = Object.keys(CHECK_MAP);
				return healthJson(
					c,
					await runChecks(deps, allCheckNames, DEFAULT_TIMEOUT_MS),
				);
			}

			await next();
		},
	};
}

export { healthMiddleware };
export type { HealthDeps, HealthResponse, CheckResult };
