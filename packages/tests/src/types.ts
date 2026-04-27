// Frozen public types for the e2e test framework. PR 1 ships the full
// surface; PRs 2-17 implement the methods marked "not implemented" without
// changing any signature. Adding a primitive that requires a new signature
// MUST be a deliberate proposal-level decision, not a per-PR refactor.

interface AppHandle {
	readonly baseUrl: string;
}

interface WorkflowOpts {
	owner?: string;
	repo?: string;
	label?: string;
}

interface FetchOpts extends RequestInit {
	auth?: { user: string; via: "cookie" | "api-header" };
	as?: "json" | "text" | "response";
	label?: string;
}

interface WebhookOpts {
	body?: unknown;
	headers?: HeadersInit;
	query?: Record<string, string>;
	owner?: string;
	repo?: string;
	label?: string;
}

interface ManualOpts {
	user?: string;
	owner?: string;
	repo?: string;
	label?: string;
}

interface EventFilter {
	label?: string;
	kind?: "trigger.request" | "trigger.response" | "trigger.error";
	archived?: boolean;
	trigger?: string;
	owner?: string;
	repo?: string;
}

interface SignalOpts {
	restart?: boolean;
}

interface WorkflowRef {
	name: string;
	sha: string;
	owner: string;
	repo: string;
}

interface UploadEntry {
	owner: string;
	repo: string;
	workflows: readonly { name: string; sha: string }[];
}

interface HttpResponse {
	status: number;
	headers: Headers;
	body: unknown;
}

type FetchResult = HttpResponse;

interface LogLine {
	level: number;
	time: number;
	msg: string;
	[key: string]: unknown;
}

// Persistence-dir event entries, polled by `.waitForEvent` (PR 3+). PR 1
// only stubs the array as empty.
interface InvocationEvent {
	id: string;
	kind: string;
	at: number;
	[key: string]: unknown;
}

interface InvocationArchive {
	invocationId: string;
	owner: string;
	repo: string;
	workflow: string;
	[key: string]: unknown;
}

type CapturedSeq<T> = readonly T[] & {
	byIndex(i: number): T;
	byLabel(name: string): T;
};

interface MockCapture {
	ts: number;
	slug?: string;
}

interface MockClient<TCapture extends MockCapture> {
	captures(opts?: {
		slug?: string;
		since?: number;
	}): Promise<readonly TCapture[]>;
	waitFor(
		predicate: (c: TCapture) => boolean,
		opts?: { slug?: string; hardCap?: number },
	): Promise<TCapture>;
	reset(slug?: string): Promise<void>;
}

interface HttpCapture extends MockCapture {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

interface MailCapture extends MockCapture {
	from: string;
	to: string[];
	subject: string;
	body: string;
}

interface SqlCapture extends MockCapture {
	statement: string;
}

// Browser context (PR 16+). Type-only import keeps `@playwright/test` out
// of the runtime cost path — only chain steps that touch `.browser` actually
// load it.
type Page = import("@playwright/test").Page;

interface BrowserContext {
	page: Page;
	state: ScenarioState;
	login: (user: string) => Promise<void>;
}

interface ScenarioState {
	workflows: CapturedSeq<WorkflowRef>;
	uploads: CapturedSeq<UploadEntry>;
	responses: CapturedSeq<HttpResponse | { error: string }>;
	fetches: CapturedSeq<FetchResult>;
	events: readonly InvocationEvent[];
	archives: CapturedSeq<InvocationArchive>;
	logs: readonly LogLine[];
	http: MockClient<HttpCapture>;
	smtp: MockClient<MailCapture>;
	sql: MockClient<SqlCapture>;
}

interface Scenario {
	workflow(name: string, source: string, opts?: WorkflowOpts): Scenario;
	upload(opts?: { label?: string }): Scenario;
	fetch(path: string, opts?: FetchOpts): Scenario;
	webhook(triggerName: string, opts?: WebhookOpts): Scenario;
	manual(triggerName: string, input?: unknown, opts?: ManualOpts): Scenario;
	waitForEvent(filter: EventFilter, opts?: { hardCap?: number }): Scenario;
	expect(
		callback: (state: ScenarioState) => void | Promise<void>,
		opts?: { hardCap?: number },
	): Scenario;
	sigterm(opts?: SignalOpts): Scenario;
	sigkill(opts?: SignalOpts): Scenario;
	browser(callback: (ctx: BrowserContext) => Promise<void>): Scenario;
}

export type {
	AppHandle,
	BrowserContext,
	CapturedSeq,
	EventFilter,
	FetchOpts,
	FetchResult,
	HttpCapture,
	HttpResponse,
	InvocationArchive,
	InvocationEvent,
	LogLine,
	MailCapture,
	ManualOpts,
	MockCapture,
	MockClient,
	Scenario,
	ScenarioState,
	SignalOpts,
	SqlCapture,
	UploadEntry,
	WebhookOpts,
	WorkflowOpts,
	WorkflowRef,
};
