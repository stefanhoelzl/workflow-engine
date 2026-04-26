import { createCapturedSeq } from "./captured-seq.js";
import { scanEvents, waitForEvent } from "./events.js";
import { buildFixture } from "./fixtures.js";
import type { Marker } from "./log-stream.js";
import type { SpawnedChild } from "./spawn.js";
import type {
	BrowserContext,
	EventFilter,
	HttpResponse,
	InvocationEvent,
	LogLine,
	MockClient,
	Scenario,
	ScenarioState,
	UploadEntry,
	WebhookOpts,
	WorkflowOpts,
	WorkflowRef,
} from "./types.js";
import { uploadFixture } from "./upload.js";

const DEFAULT_OWNER = "dev";
const DEFAULT_REPO = "e2e";
const DEFAULT_USER = "dev";
const DEFAULT_EXPECT_HARDCAP_MS = 5000;
const EXPECT_RETRY_INTERVAL_MS = 50;

interface ScenarioRunContext {
	child: SpawnedChild;
	// Per-test env overrides forwarded to the fixture build (read by the
	// IIFE-eval VM). PR 1 always passes `GREETING=hello-from-cli` for the env
	// round-trip test; later PRs may make this configurable.
	buildEnv: Record<string, string>;
	// Marker captured at test start; `state.logs` is sliced from here so
	// each test only sees its own log lines (PR 8).
	logMarker: Marker;
}

interface QueuedWorkflow {
	name: string;
	source: string;
	owner: string;
	repo: string;
	label?: string;
}

interface MutableState {
	workflows: WorkflowRef[];
	workflowLabels: Map<string, WorkflowRef>;
	uploads: UploadEntry[];
	uploadLabels: Map<string, UploadEntry>;
	responses: (HttpResponse | { error: string })[];
	responseLabels: Map<string, HttpResponse | { error: string }>;
}

type Step = (state: MutableState, ctx: ScenarioRunContext) => Promise<void>;

function methodPr(method: string): string {
	switch (method) {
		case "manual":
			return "(later)";
		case "fetch":
			return "11";
		case "sigterm":
			return "10";
		case "sigkill":
			return "9";
		case "browser":
			return "16";
		default:
			return "?";
	}
}

function notImplemented(method: string): never {
	throw new Error(
		`Scenario.${method}: not implemented in this build (PR ${methodPr(method)})`,
	);
}

function throwingMockClient<T extends { ts: number; slug?: string }>(
	name: string,
): MockClient<T> {
	const fail = (op: string) =>
		Promise.reject(
			new Error(
				`state.${name}.${op}: mock infrastructure not implemented in this build (PR 13+)`,
			),
		);
	return {
		captures: () => fail("captures") as Promise<readonly T[]>,
		waitFor: () => fail("waitFor") as Promise<T>,
		reset: () => fail("reset") as Promise<void>,
	};
}

function freshScenarioState(
	state: MutableState,
	events: readonly InvocationEvent[],
	logs: readonly LogLine[],
): ScenarioState {
	const empty = createCapturedSeq([]);
	return {
		workflows: createCapturedSeq(state.workflows, state.workflowLabels),
		uploads: createCapturedSeq(state.uploads, state.uploadLabels),
		responses: createCapturedSeq(state.responses, state.responseLabels),
		fetches: empty as ScenarioState["fetches"],
		events,
		archives: empty as ScenarioState["archives"],
		logs,
		http: throwingMockClient("http"),
		smtp: throwingMockClient("smtp"),
		sql: throwingMockClient("sql"),
	};
}

interface ScenarioInternals {
	run(ctx: ScenarioRunContext): Promise<void>;
}

interface QueueState {
	pending: QueuedWorkflow[];
}

async function flushUploads(
	queue: QueueState,
	state: MutableState,
	ctx: ScenarioRunContext,
	uploadLabel?: string,
): Promise<void> {
	if (queue.pending.length === 0) {
		return;
	}
	const groups = new Map<string, QueuedWorkflow[]>();
	for (const wf of queue.pending) {
		const key = `${wf.owner}/${wf.repo}`;
		const list = groups.get(key) ?? [];
		list.push(wf);
		groups.set(key, list);
	}
	queue.pending = [];
	for (const [key, group] of groups) {
		const sep = key.indexOf("/");
		const owner = key.slice(0, sep);
		const repo = key.slice(sep + 1);
		const fixture = await buildFixture({
			workflows: group.map((wf) => ({ name: wf.name, source: wf.source })),
			buildEnv: ctx.buildEnv,
		});
		await uploadFixture({
			cwd: fixture.cwd,
			url: ctx.child.baseUrl,
			owner,
			repo,
			user: DEFAULT_USER,
			buildEnv: ctx.buildEnv,
		});
		const shaByName = new Map(fixture.workflows.map((w) => [w.name, w.sha]));
		for (const wf of group) {
			const ref: WorkflowRef = {
				name: wf.name,
				sha: shaByName.get(wf.name) ?? "",
				owner,
				repo,
			};
			state.workflows.push(ref);
			if (wf.label !== undefined) {
				state.workflowLabels.set(wf.label, ref);
			}
		}
		const entry: UploadEntry = {
			owner,
			repo,
			workflows: group.map((wf) => ({
				name: wf.name,
				sha: shaByName.get(wf.name) ?? "",
			})),
		};
		state.uploads.push(entry);
		if (uploadLabel !== undefined) {
			state.uploadLabels.set(uploadLabel, entry);
		}
	}
}

async function fireWebhook(
	state: MutableState,
	ctx: ScenarioRunContext,
	triggerName: string,
	opts: WebhookOpts,
): Promise<void> {
	const owner = opts.owner ?? DEFAULT_OWNER;
	const repo = opts.repo ?? DEFAULT_REPO;
	const wfRef = state.workflows.find(
		(w) => w.owner === owner && w.repo === repo,
	);
	if (!wfRef) {
		throw new Error(
			`webhook: no uploaded workflow under (${owner}, ${repo}); call .workflow(...) first`,
		);
	}
	const url = new URL(
		`${ctx.child.baseUrl}/webhooks/${owner}/${repo}/${wfRef.name}/${triggerName}`,
	);
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) {
			url.searchParams.set(k, v);
		}
	}
	const headers = new Headers(opts.headers);
	const init: RequestInit = { method: "POST", headers };
	if (opts.body !== undefined) {
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		init.body = JSON.stringify(opts.body);
	}
	let entry: HttpResponse | { error: string };
	try {
		const res = await fetch(url, init);
		const ct = res.headers.get("content-type") ?? "";
		const body: unknown = ct.includes("application/json")
			? await res.json()
			: await res.text();
		entry = { status: res.status, headers: res.headers, body };
	} catch (err) {
		entry = { error: err instanceof Error ? err.message : String(err) };
	}
	state.responses.push(entry);
	if (opts.label !== undefined) {
		state.responseLabels.set(opts.label, entry);
	}
}

async function runExpect(
	state: MutableState,
	ctx: ScenarioRunContext,
	callback: (s: ScenarioState) => void | Promise<void>,
	hardCap: number,
): Promise<void> {
	const deadline = Date.now() + hardCap;
	let lastErr: unknown;
	// Retry-on-state-change: events are re-scanned from the spawned child's
	// persistence dir on every attempt, so callbacks asserting on
	// `state.events` pick up freshly-flushed pending/archive files.
	do {
		const events = await scanEvents(ctx.child.persistencePath);
		const logs = ctx.child.logStream.since(ctx.logMarker);
		try {
			await callback(freshScenarioState(state, events, logs));
			return;
		} catch (err) {
			lastErr = err;
			if (Date.now() >= deadline) {
				break;
			}
			await new Promise((res) => setTimeout(res, EXPECT_RETRY_INTERVAL_MS));
		}
	} while (Date.now() < deadline);
	throw lastErr;
}

function createScenario(): Scenario & ScenarioInternals {
	const steps: Step[] = [];
	const queue: QueueState = { pending: [] };

	const scenario: Scenario & ScenarioInternals = {
		workflow(name: string, source: string, opts?: WorkflowOpts) {
			const owner = opts?.owner ?? DEFAULT_OWNER;
			const repo = opts?.repo ?? DEFAULT_REPO;
			const queued: QueuedWorkflow = { name, source, owner, repo };
			if (opts?.label !== undefined) {
				queued.label = opts.label;
			}
			// Enqueue lazily so a later `.workflow(...)` call after an
			// `.upload()` / `.webhook()` doesn't leak into an earlier upload's
			// flush. Sequencing is decided by step order, not chain-build order.
			steps.push(() => {
				queue.pending.push(queued);
				return Promise.resolve();
			});
			return scenario;
		},
		webhook(triggerName: string, opts?: WebhookOpts) {
			const fixedOpts = opts ?? {};
			steps.push(async (state, ctx) => {
				await flushUploads(queue, state, ctx);
				await fireWebhook(state, ctx, triggerName, fixedOpts);
			});
			return scenario;
		},
		expect(callback, opts) {
			const hardCap = opts?.hardCap ?? DEFAULT_EXPECT_HARDCAP_MS;
			steps.push((state, ctx) => runExpect(state, ctx, callback, hardCap));
			return scenario;
		},
		upload(opts?: { label?: string }) {
			const label = opts?.label;
			steps.push(async (state, ctx) => {
				await flushUploads(queue, state, ctx, label);
			});
			return scenario;
		},
		fetch(): Scenario {
			return notImplemented("fetch");
		},
		manual(): Scenario {
			return notImplemented("manual");
		},
		waitForEvent(filter: EventFilter, opts?: { hardCap?: number }) {
			steps.push(async (state, ctx) => {
				// Implicit flush so cron-only chains (no `.webhook`/`.manual`
				// firing step before the wait) still register their workflow
				// with the runtime — otherwise the cron source has nothing to
				// arm and the wait would simply time out.
				await flushUploads(queue, state, ctx);
				await waitForEvent(ctx.child.persistencePath, filter, opts);
			});
			return scenario;
		},
		sigterm(): Scenario {
			return notImplemented("sigterm");
		},
		sigkill(): Scenario {
			return notImplemented("sigkill");
		},
		browser(_cb: (c: BrowserContext) => Promise<void>): Scenario {
			return notImplemented("browser");
		},
		async run(ctx: ScenarioRunContext) {
			const state: MutableState = {
				workflows: [],
				workflowLabels: new Map(),
				uploads: [],
				uploadLabels: new Map(),
				responses: [],
				responseLabels: new Map(),
			};
			for (const step of steps) {
				await step(state, ctx);
			}
		},
	};

	return scenario;
}

export type { ScenarioInternals, ScenarioRunContext };
export { createScenario };
