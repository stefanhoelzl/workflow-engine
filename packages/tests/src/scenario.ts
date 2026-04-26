import { createCapturedSeq } from "./captured-seq.js";
import { buildFixture } from "./fixtures.js";
import type { SpawnedChild } from "./spawn.js";
import type {
	BrowserContext,
	HttpResponse,
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
}

interface QueuedWorkflow {
	name: string;
	source: string;
	owner: string;
	repo: string;
}

interface MutableState {
	workflows: WorkflowRef[];
	uploads: UploadEntry[];
	responses: (HttpResponse | { error: string })[];
}

type Step = (state: MutableState, ctx: ScenarioRunContext) => Promise<void>;

function methodPr(method: string): string {
	switch (method) {
		case "upload":
			return "4";
		case "manual":
			return "(later)";
		case "fetch":
			return "11";
		case "waitForEvent":
			return "3";
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

function freshScenarioState(state: MutableState): ScenarioState {
	const empty = createCapturedSeq([]);
	return {
		workflows: createCapturedSeq(state.workflows),
		uploads: createCapturedSeq(state.uploads),
		responses: createCapturedSeq(state.responses),
		fetches: empty as ScenarioState["fetches"],
		events: [],
		archives: empty as ScenarioState["archives"],
		logs: [],
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
		if (group.length !== 1) {
			throw new Error(
				"PR 1 supports at most one workflow per (owner, repo); multi-workflow uploads land in PR 4",
			);
		}
		const wf = group[0];
		if (!wf) {
			continue;
		}
		const fixture = await buildFixture({
			name: wf.name,
			source: wf.source,
		});
		await uploadFixture({
			cwd: fixture.cwd,
			url: ctx.child.baseUrl,
			owner,
			repo,
			user: DEFAULT_USER,
		});
		state.workflows.push({ name: wf.name, sha: "", owner, repo });
		state.uploads.push({
			owner,
			repo,
			workflows: [{ name: wf.name, sha: "" }],
		});
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
	try {
		const res = await fetch(url, init);
		const ct = res.headers.get("content-type") ?? "";
		const body: unknown = ct.includes("application/json")
			? await res.json()
			: await res.text();
		state.responses.push({ status: res.status, headers: res.headers, body });
	} catch (err) {
		state.responses.push({
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function runExpect(
	state: MutableState,
	callback: (s: ScenarioState) => void | Promise<void>,
	hardCap: number,
): Promise<void> {
	const deadline = Date.now() + hardCap;
	let lastErr: unknown;
	// Retry-on-state-change: PR 1's state is fully populated at .expect() time
	// (sync upload + webhook), so the first attempt usually wins. The retry
	// loop is here to keep the contract for PR 3+ (FS-polled events). Run at
	// least once even if hardCap is 0.
	do {
		try {
			await callback(freshScenarioState(state));
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
			queue.pending.push({ name, source, owner, repo });
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
			steps.push((state) => runExpect(state, callback, hardCap));
			return scenario;
		},
		upload(): Scenario {
			return notImplemented("upload");
		},
		fetch(): Scenario {
			return notImplemented("fetch");
		},
		manual(): Scenario {
			return notImplemented("manual");
		},
		waitForEvent(): Scenario {
			return notImplemented("waitForEvent");
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
				uploads: [],
				responses: [],
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
