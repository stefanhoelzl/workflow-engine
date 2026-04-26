import { createCapturedSeq } from "./captured-seq.js";
import { type InternalFilter, scanEvents, waitForEvent } from "./events.js";
import { buildFixture } from "./fixtures.js";
import type { Marker } from "./log-stream.js";
import type { SpawnedChild } from "./spawn.js";
import type {
	BrowserContext,
	EventFilter,
	FetchOpts,
	FetchResult,
	HttpResponse,
	InvocationEvent,
	LogLine,
	MockClient,
	Scenario,
	ScenarioState,
	SignalOpts,
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
const POLL_INTERVAL_MS = 25;
const DEFAULT_HARDCAP_MS = 5000;

interface ScenarioRunContext {
	getChild(): SpawnedChild;
	respawn(): Promise<void>;
	buildEnv: Record<string, string>;
	getLogMarker(): Marker;
	resetLogMarker(): void;
}

interface QueuedWorkflow {
	name: string;
	source: string;
	owner: string;
	repo: string;
	label?: string;
}

interface InvocationLabel {
	owner: string;
	repo: string;
	trigger: string;
	preFireIds: Set<string>;
	resolvedId?: string;
}

interface MutableState {
	workflows: WorkflowRef[];
	workflowLabels: Map<string, WorkflowRef>;
	uploads: UploadEntry[];
	uploadLabels: Map<string, UploadEntry>;
	responses: (HttpResponse | { error: string })[];
	responseLabels: Map<string, HttpResponse | { error: string }>;
	fetches: FetchResult[];
	fetchLabels: Map<string, FetchResult>;
	// In-flight fetch promises from fire-and-forget `.webhook` / `.manual`.
	// Drained at each `.expect` (so the callback sees a terminal response,
	// never a placeholder) and before each new `.webhook` (so back-to-back
	// fires sequence cleanly without re-introducing a fully synchronous
	// webhook semantics that would deadlock the crash-recovery test).
	inFlight: Promise<void>[];
	// Labeled fire registers an `InvocationLabel`. The first
	// `.waitForEvent({label})` resolves the label to the new invocation id;
	// subsequent waits filter by that exact id.
	invocationLabels: Map<string, InvocationLabel>;
}

type Step = (state: MutableState, ctx: ScenarioRunContext) => Promise<void>;

function methodPr(method: string): string {
	switch (method) {
		case "manual":
			return "(later)";
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
		fetches: createCapturedSeq(state.fetches, state.fetchLabels),
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
			url: ctx.getChild().baseUrl,
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
		`${ctx.getChild().baseUrl}/webhooks/${owner}/${repo}/${wfRef.name}/${triggerName}`,
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

	// Snapshot known invocation ids BEFORE firing so a labeled wait can
	// distinguish this fire's invocation from any prior one.
	if (opts.label !== undefined) {
		const events = await scanEvents(ctx.getChild().persistencePath);
		state.invocationLabels.set(opts.label, {
			owner,
			repo,
			trigger: triggerName,
			preFireIds: new Set(events.map((e) => e.id)),
		});
	}

	// Fire-and-forget per spec: kick the request off and track its promise.
	// Destructive steps (`.sigkill`, `.sigterm`) can land on the in-flight
	// invocation. `.expect` drains in-flight before each retry attempt.
	const slot = state.responses.length;
	state.responses.push({ error: "(in-flight)" });
	const p = (async () => {
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
		state.responses[slot] = entry;
		if (opts.label !== undefined) {
			state.responseLabels.set(opts.label, entry);
		}
	})();
	state.inFlight.push(p);
}

function inferAs(contentType: string): "json" | "text" {
	return contentType.includes("json") ? "json" : "text";
}

async function runFetch(
	state: MutableState,
	ctx: ScenarioRunContext,
	path: string,
	opts: FetchOpts,
): Promise<void> {
	if (opts.auth !== undefined) {
		throw new Error(
			"Scenario.fetch: opts.auth is not implemented in this build (PR 12)",
		);
	}
	const url = `${ctx.getChild().baseUrl}${path}`;
	const { as, label, ...init } = opts;
	const res = await fetch(url, init as RequestInit);
	const contentType = res.headers.get("content-type") ?? "";
	const mode = as ?? inferAs(contentType);
	let body: unknown;
	if (mode === "response") {
		body = undefined;
	} else if (mode === "json") {
		const text = await res.text();
		body = text === "" ? undefined : JSON.parse(text);
	} else {
		body = await res.text();
	}
	const entry: FetchResult = { status: res.status, headers: res.headers, body };
	state.fetches.push(entry);
	if (label !== undefined) {
		state.fetchLabels.set(label, entry);
	}
}

async function awaitInFlight(state: MutableState): Promise<void> {
	if (state.inFlight.length === 0) {
		return;
	}
	const pending = state.inFlight.splice(0);
	await Promise.allSettled(pending);
}

async function runExpect(
	state: MutableState,
	ctx: ScenarioRunContext,
	callback: (s: ScenarioState) => void | Promise<void>,
	hardCap: number,
): Promise<void> {
	await awaitInFlight(state);
	const deadline = Date.now() + hardCap;
	let lastErr: unknown;
	do {
		const events = await scanEvents(ctx.getChild().persistencePath);
		const logs = ctx.getChild().logStream.since(ctx.getLogMarker());
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

const TRIGGER_KINDS = new Set<string>([
	"trigger.request",
	"trigger.response",
	"trigger.error",
]);

function matchesInternal(
	event: InvocationEvent,
	filter: InternalFilter,
): boolean {
	if (filter.kind !== undefined && event.kind !== filter.kind) {
		return false;
	}
	if (filter.owner !== undefined && event.owner !== filter.owner) {
		return false;
	}
	if (filter.repo !== undefined && event.repo !== filter.repo) {
		return false;
	}
	if (filter.id !== undefined && event.id !== filter.id) {
		return false;
	}
	if (filter.trigger !== undefined) {
		if (!TRIGGER_KINDS.has(event.kind)) {
			return false;
		}
		if (event.name !== filter.trigger) {
			return false;
		}
	}
	return true;
}

async function pollForLabelMatch(
	persistencePath: string,
	internal: InternalFilter,
	excludeIds: Set<string>,
	hardCap = DEFAULT_HARDCAP_MS,
): Promise<InvocationEvent> {
	const deadline = Date.now() + hardCap;
	let latestEvents: InvocationEvent[] = [];
	const archivedScope: { archived?: boolean } = {};
	if (internal.archived !== undefined) {
		archivedScope.archived = internal.archived;
	}
	while (true) {
		latestEvents = await scanEvents(persistencePath, archivedScope);
		const found = latestEvents.find(
			(e) => !excludeIds.has(e.id) && matchesInternal(e, internal),
		);
		if (found) {
			return found;
		}
		if (Date.now() >= deadline) {
			break;
		}
		await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
	}
	const summary = latestEvents
		.slice(0, 20)
		.map((e) => `  - ${e.kind} name=${e.name} id=${e.id}`)
		.join("\n");
	throw new Error(
		`waitForEvent timed out after ${String(hardCap)}ms\nfilter: ${JSON.stringify(
			internal,
		)} (excluding ${String(excludeIds.size)} pre-fire ids)\nobserved events (${String(latestEvents.length)}):\n${summary}`,
	);
}

interface WaitForEventArgs {
	state: MutableState;
	ctx: ScenarioRunContext;
	queue: QueueState;
	filter: EventFilter;
	opts: { hardCap?: number } | undefined;
}

async function runWaitForEvent(args: WaitForEventArgs): Promise<void> {
	const { state, ctx, queue, filter, opts } = args;
	await flushUploads(queue, state, ctx);

	const internal: InternalFilter = { ...filter };

	if (filter.label !== undefined) {
		const entry = state.invocationLabels.get(filter.label);
		if (!entry) {
			throw new Error(
				`waitForEvent: label "${filter.label}" was not registered by any prior fire step`,
			);
		}
		if (entry.resolvedId === undefined) {
			internal.owner = filter.owner ?? entry.owner;
			internal.repo = filter.repo ?? entry.repo;
			if (filter.trigger === undefined) {
				internal.trigger = entry.trigger;
			}
			const resolved = await pollForLabelMatch(
				ctx.getChild().persistencePath,
				internal,
				entry.preFireIds,
				opts?.hardCap,
			);
			entry.resolvedId = resolved.id;
			return;
		}
		internal.id = entry.resolvedId;
	}

	const { label: _stripped, ...rest } = internal;
	if (_stripped !== undefined) {
		// label was already resolved into rest.id above; strip the public
		// field from what we hand to waitForEvent.
	}
	await waitForEvent(ctx.getChild().persistencePath, rest, opts);
}

async function runSigkill(
	state: MutableState,
	ctx: ScenarioRunContext,
	opts: SignalOpts,
): Promise<void> {
	const child = ctx.getChild();
	const wait = child.exited();
	child.signal("SIGKILL");
	await wait;
	// In-flight fetches still attached to the dead socket reject (ECONNRESET).
	// Drain them so they don't leak as unhandled rejections; their entries
	// land as `{error: ...}` in `state.responses`.
	await awaitInFlight(state);
	if (opts.restart === true) {
		await ctx.respawn();
		ctx.resetLogMarker();
	}
}

const SIGTERM_DRAIN_HARDCAP_MS = 15_000;

async function runSigterm(
	state: MutableState,
	ctx: ScenarioRunContext,
	opts: SignalOpts,
): Promise<void> {
	const child = ctx.getChild();
	const exitedWait = child.exited();
	child.signal("SIGTERM");
	// `shutdown.complete` is the runtime's last log line before exit; awaiting
	// it as the synchronization signal that all in-flight invocations have
	// drained (see openspec service-lifecycle spec).
	await child.logStream.waitFor((l) => l.msg === "shutdown.complete", {
		hardCap: SIGTERM_DRAIN_HARDCAP_MS,
	});
	await exitedWait;
	await awaitInFlight(state);
	if (opts.restart === true) {
		await ctx.respawn();
		ctx.resetLogMarker();
	}
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
			steps.push(() => {
				queue.pending.push(queued);
				return Promise.resolve();
			});
			return scenario;
		},
		webhook(triggerName: string, opts?: WebhookOpts) {
			const fixedOpts = opts ?? {};
			steps.push(async (state, ctx) => {
				// Sequence fires: each `.webhook` waits for any prior in-flight
				// fire to settle before issuing its own request. This makes
				// back-to-back `.webhook(v1).webhook(v2)` behave intuitively
				// (v1 completes before v2 starts) without reintroducing fully
				// synchronous webhooks (which would deadlock crash-recovery).
				await awaitInFlight(state);
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
		fetch(path: string, opts?: FetchOpts) {
			const fixed = opts ?? {};
			steps.push(async (state, ctx) => {
				await flushUploads(queue, state, ctx);
				await runFetch(state, ctx, path, fixed);
			});
			return scenario;
		},
		manual(): Scenario {
			return notImplemented("manual");
		},
		waitForEvent(filter: EventFilter, opts?: { hardCap?: number }) {
			steps.push((state, ctx) =>
				runWaitForEvent({ state, ctx, queue, filter, opts }),
			);
			return scenario;
		},
		sigterm(opts?: SignalOpts) {
			const fixed = opts ?? {};
			steps.push((state, ctx) => runSigterm(state, ctx, fixed));
			return scenario;
		},
		sigkill(opts?: SignalOpts) {
			const fixed = opts ?? {};
			steps.push((state, ctx) => runSigkill(state, ctx, fixed));
			return scenario;
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
				fetches: [],
				fetchLabels: new Map(),
				inFlight: [],
				invocationLabels: new Map(),
			};
			try {
				for (const step of steps) {
					await step(state, ctx);
				}
			} finally {
				await awaitInFlight(state);
			}
		},
	};

	return scenario;
}

export type { ScenarioInternals, ScenarioRunContext };
export { createScenario };
