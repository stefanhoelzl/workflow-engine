/**
 * @workflow-engine/sdk — comprehensive example workflow.
 *
 * This file is the canonical, full-surface authoring reference for the SDK. It
 * exercises every author-facing primitive so an agent (or a human) can copy any
 * pattern here and adapt it. It is shipped in the npm tarball and validated in
 * CI by a bundle-only build (`wfe build`, never uploaded) — because bundling
 * typechecks + compiles without executing handlers, this file can demonstrate
 * `imapTrigger` / `wsTrigger` (which need a mail server / live client to *run*)
 * and still prove they compile against the real SDK types.
 *
 * How a workflow is structured:
 *   - exactly one `defineWorkflow({env})` module export — the env contract,
 *   - zero or more `action({input, output, handler})` — typed callables,
 *   - one or more triggers (`httpTrigger` / `cronTrigger` / `manualTrigger` /
 *     `imapTrigger` / `wsTrigger`) — entry points.
 * Wiring is plain TypeScript: a trigger handler calls actions directly
 * (`await greet({name})`), and actions call other actions. There is no event
 * bus, no `emit()`, no subscriber model.
 *
 * Authoring gotchas enforced by `wfe build` (it uses its OWN strict compiler
 * options and IGNORES your tsconfig, so a lax editor config can pass locally
 * then fail the build):
 *   - use `z.exactOptional(...)`, not `.optional()`, for optional object fields,
 *   - use `z.unknown()` (not `z.void()`/`z.undefined()`) for no-return actions,
 *   - all relative imports need explicit `.js` extensions.
 *
 * Everything is dispatched through the `runDemo` orchestrator so every trigger
 * kind exercises the full surface.
 */
import {
	action,
	cronTrigger,
	defineQueue,
	defineWorkflow,
	env,
	executeSql,
	httpTrigger,
	imapTrigger,
	manualTrigger,
	secret,
	sendMail,
	wsTrigger,
	z,
} from "@workflow-engine/sdk";

// `Observable` (WICG tentative) is not yet in TypeScript's lib.dom, so declare
// the minimal shape the example needs. The runtime installs the real global via
// packages/sandbox-stdlib. Every other global used below (`fetch`, `crypto`,
// `setTimeout`, `URL`, `performance`, `EventTarget`, `AbortController`,
// `scheduler`, `console`) is standard-typed and provided by sandbox-stdlib.
declare const Observable: {
	new <T>(
		subscribe: (sub: {
			next: (v: T) => void;
			complete: () => void;
			error: (e: unknown) => void;
		}) => void,
	): {
		subscribe(observer: {
			next?: (v: T) => void;
			complete?: () => void;
			error?: (e: unknown) => void;
		}): void;
	};
};

const MEASURE_DELAY_MS = 5;

// Hoisted to module scope (lint/performance/useTopLevelRegex). Extracts
// ethereal.email's preview-message id from the raw SMTP `250 Accepted` string.
const ETHEREAL_MSGID_RE = /MSGID=([^\s\]]+)/;

// Length filter for the parameterized sample query — a non-empty slice of the
// `rna` table without relying on its exact contents.
const SAMPLE_RNA_LEN = 100;

// Per-item queue caps. The queue's hard byte cap is 1 KB host-side; these
// schema-level caps shape author intent (notes are short labels).
const JOB_NOTE_MAX = 64;
const DRAIN_MAX_ITEMS = 100;
const DRAIN_DEFAULT_ITEMS = 10;

/**
 * `defineWorkflow({env})` declares the workflow-level environment contract and
 * returns a frozen `workflow.env` record read at handler time. Each field is an
 * `env(...)` ref: `env({default})` supplies a fallback, `env({secret: true})`
 * marks a value the build seals against the server's public key (it is injected
 * as plaintext only inside the sandbox and scrubbed from logs).
 */
export const workflow = defineWorkflow({
	env: {
		GREETING_PREFIX: env({ default: "Hello" }),
		WEBHOOK_TOKEN: env({ secret: true }),
		// RNAcentral's public read-only Postgres. All five fields are plain
		// config with defaults; the "password" is a publicly published
		// credential (https://rnacentral.org/help/public-database), not a
		// secret, so the example self-bootstraps without operator env exports.
		RNACENTRAL_HOST: env({ default: "hh-pgsql-public.ebi.ac.uk" }),
		RNACENTRAL_PORT: env({ default: "5432" }),
		RNACENTRAL_USER: env({ default: "reader" }),
		RNACENTRAL_DB: env({ default: "pfmegrnargs" }),
		// biome-ignore lint/security/noSecrets: RNAcentral publishes this credential publicly; see RNACENTRAL_HOST comment above
		RNACENTRAL_PASSWORD: env({ default: "NWDMCE5xdipIjRrp" }),
		IMAP_USER: env({ secret: true }),
		IMAP_PASSWORD: env({ secret: true }),
	},
});

/**
 * `action({input, output, handler})` defines a typed callable. `input`/`output`
 * are Zod schemas the runtime validates at the sandbox bridge; the returned
 * value is itself callable — `await greet({name})` — from any other action or
 * trigger handler. Action identity is the export name (`greet`).
 */
export const greet = action({
	input: z.object({ name: z.string() }),
	output: z.string(),
	handler: async ({ name }) => `${workflow.env.GREETING_PREFIX}, ${name}!`,
});

/** Action-calls-action: composition is a plain awaited function call. */
export const shout = action({
	input: z.object({ name: z.string() }),
	output: z.string(),
	handler: async ({ name }) => (await greet({ name })).toUpperCase(),
});

/** sandbox-stdlib `crypto.subtle` — SHA-256 digest. */
export const hash = action({
	input: z.object({ text: z.string() }),
	output: z.object({ sha256Hex: z.string() }),
	handler: async ({ text }) => {
		const hexRadix = 16;
		const hexPad = 2;
		const bytes = new TextEncoder().encode(text);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const sha256Hex = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(hexRadix).padStart(hexPad, "0"))
			.join("");
		return { sha256Hex };
	},
});

/** sandbox-stdlib `crypto.randomUUID`. An empty input object is valid. */
export const uuid = action({
	input: z.object({}),
	output: z.object({ uuid: z.string() }),
	handler: async () => ({ uuid: crypto.randomUUID() }),
});

/** sandbox-stdlib `setTimeout` wrapped in a Promise. */
export const delay = action({
	input: z.object({ ms: z.number() }),
	output: z.object({ delayedMs: z.number() }),
	handler: async ({ ms }) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return { delayedMs: ms };
	},
});

/** sandbox-stdlib `URL` / `URLSearchParams`. */
export const parseUrl = action({
	input: z.object({ url: z.string() }),
	output: z.object({
		host: z.string(),
		query: z.record(z.string(), z.string()),
	}),
	handler: ({ url }) => {
		const parsed = new URL(url);
		const query = Object.fromEntries(parsed.searchParams);
		return Promise.resolve({ host: parsed.host, query });
	},
});

/**
 * `secret(value)` wraps a computed sensitive value so the log scrubber redacts
 * it if it is ever logged. Here we HMAC-sign a subject with the sealed
 * `WEBHOOK_TOKEN` env secret and deliberately log both to show scrubbing.
 */
export const signedPing = action({
	input: z.object({ subject: z.string() }),
	output: z.object({ sig: z.string() }),
	handler: async ({ subject }) => {
		const hexRadix = 16;
		const hexPad = 2;
		const nonce = crypto.randomUUID();
		const material = `${nonce}.${subject}`;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(workflow.env.WEBHOOK_TOKEN),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sigBytes = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(material),
		);
		const sig = secret(
			Array.from(new Uint8Array(sigBytes))
				.map((b) => b.toString(hexRadix).padStart(hexPad, "0"))
				.join(""),
		);
		// biome-ignore lint/suspicious/noConsole: intentional — exercises the log scrubber by logging known plaintexts
		console.log(
			`signing ${subject} with ${workflow.env.WEBHOOK_TOKEN}; sig=${sig}`,
		);
		return { sig };
	},
});

/** sandbox-stdlib `fetch` happy path — GET and POST JSON. */
export const fetchEcho = action({
	input: z.object({ payload: z.object({ hello: z.string() }) }),
	output: z.object({ get: z.unknown(), post: z.unknown() }),
	handler: async ({ payload }) => {
		const getResponse = await fetch("https://httpbin.org/get");
		// biome-ignore lint/suspicious/noConsole: intentional — documents the sandbox-stdlib `console` surface
		console.log(`GET httpbin.org/get -> ${getResponse.status}`);
		const get = await getResponse.json();

		const postResponse = await fetch("https://httpbin.org/post", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		// biome-ignore lint/suspicious/noConsole: intentional — documents the sandbox-stdlib `console` surface
		console.log(`POST httpbin.org/post -> ${postResponse.status}`);
		const post = await postResponse.json();

		return { get, post };
	},
});

/**
 * `fetch` error path — a bad URL throws a TypeError from the shim, which the
 * handler catches and surfaces as a structured result instead of an action
 * error. The idiomatic pattern for "call may fail, don't crash the invocation".
 */
export const fetchSafe = action({
	input: z.object({ url: z.string() }),
	output: z.object({ ok: z.boolean(), status: z.number(), error: z.string() }),
	handler: async ({ url }) => {
		try {
			const response = await fetch(url);
			return { ok: response.ok, status: response.status, error: "" };
		} catch (err) {
			return {
				ok: false,
				status: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
});

// -----------------------------------------------------------------------------
// sandbox-stdlib Web Platform surface. Each action exercises at least one global
// per category so a regression in the polyfill install chain surfaces here.
// -----------------------------------------------------------------------------

/** `performance.mark` / `performance.measure` (user-timing). */
export const measure = action({
	input: z.object({ label: z.string() }),
	output: z.object({ entries: z.number(), durationMs: z.number() }),
	handler: async ({ label }) => {
		performance.mark(`${label}:start`);
		await new Promise((resolve) => setTimeout(resolve, MEASURE_DELAY_MS));
		performance.mark(`${label}:end`);
		performance.measure(label, `${label}:start`, `${label}:end`);
		const entries = performance.getEntriesByName(label);
		const durationMs = entries[0]?.duration ?? 0;
		return { entries: entries.length, durationMs };
	},
});

/** `EventTarget` / `CustomEvent`. */
export const eventBus = action({
	input: z.object({ message: z.string() }),
	output: z.object({ received: z.string() }),
	handler: ({ message }) => {
		const target = new EventTarget();
		let received = "";
		target.addEventListener("demo", (e) => {
			received = (e as CustomEvent<string>).detail;
		});
		target.dispatchEvent(new CustomEvent("demo", { detail: message }));
		return Promise.resolve({ received });
	},
});

/**
 * `AbortController` / `AbortSignal`. `fetch.signal` is not plumbed across the
 * host bridge, so this exercises the controller/signal object shape rather than
 * live cancellation.
 */
export const cancellable = action({
	input: z.object({}),
	output: z.object({ aborted: z.boolean(), reason: z.string() }),
	handler: () => {
		const controller = new AbortController();
		controller.abort(new Error("demo-cancel"));
		const reason = controller.signal.reason;
		return Promise.resolve({
			aborted: controller.signal.aborted,
			reason: reason instanceof Error ? reason.message : String(reason),
		});
	},
});

/** `scheduler.postTask` (scheduler polyfill), user-blocking priority. */
export const scheduleTask = action({
	input: z.object({ value: z.number() }),
	output: z.object({ doubled: z.number() }),
	handler: async ({ value }) => {
		const doubled = await scheduler.postTask(() => value * 2, {
			priority: "user-blocking",
		});
		return { doubled };
	},
});

/** `Observable.subscribe` (WICG tentative observable polyfill). */
export const observeTicks = action({
	input: z.object({ count: z.number() }),
	output: z.object({ values: z.array(z.number()) }),
	handler: ({ count }) => {
		const source = new Observable<number>((subscriber) => {
			for (let i = 0; i < count; i++) {
				subscriber.next(i);
			}
			subscriber.complete();
		});
		const values: number[] = [];
		source.subscribe({ next: (v) => values.push(v) });
		return Promise.resolve({ values });
	},
});

/**
 * `executeSql(dsn, sql, params?)` — parameterized queries against a Postgres
 * DSN. Runs a healthcheck, a parameterized sample, and a deliberate syntax
 * error to exercise the `sql.error` path. Targets RNAcentral's public read-only
 * EBI instance; credentials are published by EMBL-EBI for exactly this use.
 */
export const querySql = action({
	input: z.object({}),
	output: z.object({
		greeting: z.number(),
		sampleCount: z.number(),
		syntaxErrorObserved: z.boolean(),
	}),
	handler: async () => {
		const dsn = `postgres://${workflow.env.RNACENTRAL_USER}:${workflow.env.RNACENTRAL_PASSWORD}@${workflow.env.RNACENTRAL_HOST}:${workflow.env.RNACENTRAL_PORT}/${workflow.env.RNACENTRAL_DB}`;
		const ping = await executeSql(dsn, "SELECT 1 AS greeting");
		const sample = await executeSql(
			dsn,
			"SELECT upi FROM rna WHERE len = $1 LIMIT 5",
			[SAMPLE_RNA_LEN],
		);
		let syntaxErrorObserved = false;
		try {
			await executeSql(dsn, "SELECT bogus FROM nope");
		} catch {
			syntaxErrorObserved = true;
		}
		return {
			greeting: Number(ping.rows[0]?.greeting ?? 0),
			sampleCount: sample.rowCount,
			syntaxErrorObserved,
		};
	},
});

/**
 * `sendMail(options)` — SMTP send via the mail plugin. Bootstraps throwaway
 * ethereal.email credentials over the public nodemailer REST endpoint, sends a
 * tiny message, and returns a clickable preview URL (nothing is delivered).
 */
export const sendDemo = action({
	input: z.object({ to: z.string() }),
	output: z.object({ messageId: z.string(), viewUrl: z.string() }),
	handler: async ({ to }) => {
		const bootstrapRes = await fetch("https://api.nodemailer.com/user", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestor: "workflow-engine-example",
				version: "1",
			}),
		});
		if (!bootstrapRes.ok) {
			throw new Error(
				`ethereal bootstrap failed: ${bootstrapRes.status} ${bootstrapRes.statusText}`,
			);
		}
		const creds = (await bootstrapRes.json()) as {
			user: string;
			pass: string;
			smtp: { host: string; port: number; secure: boolean };
			web: string;
		};

		const result = await sendMail({
			smtp: {
				host: creds.smtp.host,
				port: creds.smtp.port,
				tls: "starttls",
				auth: { user: creds.user, pass: creds.pass },
			},
			from: `"Workflow Engine Example" <${creds.user}>`,
			to,
			subject: "Hello from workflow-engine",
			text: "This example was sent via the sandbox-stdlib mail plugin.",
		});

		const msgIdMatch = (result.response ?? "").match(ETHEREAL_MSGID_RE);
		const previewId = msgIdMatch?.[1];
		const viewUrl = previewId
			? `${creds.web}/message/${previewId}`
			: `${creds.web}/messages`;
		return { messageId: result.messageId, viewUrl };
	},
});

/**
 * The orchestrator every trigger dispatches, so each trigger kind exercises the
 * full surface. A trigger handler is just TypeScript: call actions, compose
 * their results, return a value.
 */
export const runDemo = action({
	input: z.object({ name: z.string() }),
	output: z.object({
		greeting: z.string(),
		shouted: z.string(),
		hash: z.object({ sha256Hex: z.string() }),
		uuid: z.object({ uuid: z.string() }),
		delay: z.object({ delayedMs: z.number() }),
		parsed: z.object({
			host: z.string(),
			query: z.record(z.string(), z.string()),
		}),
		signed: z.object({ sig: z.string() }),
		fetched: z.object({ get: z.unknown(), post: z.unknown() }),
		measured: z.object({ entries: z.number(), durationMs: z.number() }),
		event: z.object({ received: z.string() }),
		cancelled: z.object({ aborted: z.boolean(), reason: z.string() }),
		scheduled: z.object({ doubled: z.number() }),
		observed: z.object({ values: z.array(z.number()) }),
		sql: z.object({
			greeting: z.number(),
			sampleCount: z.number(),
			syntaxErrorObserved: z.boolean(),
		}),
		mail: z.object({ messageId: z.string(), viewUrl: z.string() }),
	}),
	handler: async ({ name }) => {
		const greeting = await greet({ name });
		const shouted = await shout({ name });
		const hashed = await hash({ text: name });
		const uuidResult = await uuid({});
		const delayed = await delay({ ms: 100 });
		const parsed = await parseUrl({
			url: `https://example.com/path?who=${encodeURIComponent(name)}`,
		});
		const signed = await signedPing({ subject: name });
		const fetched = await fetchEcho({ payload: { hello: name } });
		const measured = await measure({ label: `run:${name}` });
		const event = await eventBus({ message: name });
		const cancelled = await cancellable({});
		const scheduled = await scheduleTask({ value: name.length });
		const observed = await observeTicks({ count: 3 });
		const sql = await querySql({});
		const mail = await sendDemo({ to: `example+${name}@example.com` });
		return {
			greeting,
			shouted,
			hash: hashed,
			uuid: uuidResult,
			delay: delayed,
			parsed,
			signed,
			fetched,
			measured,
			event,
			cancelled,
			scheduled,
			observed,
			sql,
			mail,
		};
	},
});

/**
 * `httpTrigger` — GET. For HTTP triggers the handler's return value IS the HTTP
 * response: `{status?, body?, headers?}` (all optional; defaults 200/""/{}).
 * The public URL is mechanical: `/webhooks/<owner>/<repo>/<workflow>/<export>`.
 */
export const ping = httpTrigger({
	method: "GET",
	handler: async () => {
		const result = await runDemo({ name: "http-get" });
		return { status: 200, body: result };
	},
});

/**
 * `httpTrigger` — POST with a strict `request.body` (Zod enum). A body that
 * fails validation produces a `422` + a `trigger.rejection` event before the
 * sandbox is entered; the event's `input.issues[0]` carries `received` /
 * `expected` / `code` for debugging.
 */
export const rejectMe = httpTrigger({
	method: "POST",
	request: {
		body: z.object({ kind: z.enum(["A", "B"]) }),
	},
	handler: async ({ body }) => {
		const result = await runDemo({ name: `enum-${body.kind}` });
		return { status: 200, body: result };
	},
});

/**
 * `httpTrigger` with typed `request.headers` — `x-trace-id` is optional; the
 * handler reads it from the validated `payload.headers` and echoes it back.
 */
export const echo = httpTrigger({
	request: {
		body: z.object({ name: z.string().meta({ example: "world" }) }),
		headers: z.object({
			"x-trace-id": z.string().optional(),
		}),
	},
	handler: async ({ body, headers }) => {
		const result = await runDemo({ name: body.name });
		return {
			status: 200,
			body: { ...result, traceId: headers["x-trace-id"] ?? null },
		};
	},
});

/**
 * `httpTrigger` with `response.body` AND `response.headers` — when
 * `response.body` is set the handler MUST return a `body` matching the schema,
 * and declared `response.headers` are validated on egress. Contrast `ping` /
 * `echo`, where the response shape is loose.
 */
export const greetJson = httpTrigger({
	method: "POST",
	request: {
		body: z.object({ name: z.string().meta({ example: "world" }) }),
	},
	response: {
		body: z.object({ greeting: z.string() }),
		headers: z.object({ "x-app-version": z.string() }),
	},
	handler: async ({ body }) => {
		const greeting = await greet({ name: body.name });
		return {
			status: 200,
			body: { greeting },
			headers: { "x-app-version": "1.0.0" },
		};
	},
});

/** `cronTrigger` — schedule + explicit IANA tz. Return value is discarded. */
export const everyFiveMinutes = cronTrigger({
	schedule: "*/5 * * * *",
	tz: "UTC",
	handler: async () => {
		await runDemo({ name: "cron-utc" });
	},
});

/** A second cron with a different timezone. */
export const dailyBerlin = cronTrigger({
	schedule: "0 9 * * *",
	tz: "Europe/Berlin",
	handler: async () => {
		await runDemo({ name: "cron-berlin" });
	},
});

/**
 * Callable-style cron invocation — `cronTrigger` returns a branded callable, so
 * other workflow code (or a test) can fire it directly without the scheduler.
 * Here an HTTP trigger invokes `everyFiveMinutes()` on demand.
 */
export const fireCron = httpTrigger({
	method: "POST",
	handler: async () => {
		await everyFiveMinutes();
		return { status: 202, body: { fired: "everyFiveMinutes" } };
	},
});

/**
 * `wsTrigger` — bidirectional WebSocket. Each inbound frame fires the handler
 * once with `{data}` validated against `request`; the returned value is sent
 * back to the originating client as one text frame (FIFO-correlated).
 *
 * Compile-validated here but needs a live WebSocket client to actually run.
 */
export const wsRun = wsTrigger({
	request: z.object({ name: z.string().meta({ example: "ws-demo" }) }),
	response: z.object({ greeting: z.string(), name: z.string() }),
	handler: async ({ data }) => {
		const result = await runDemo({ name: data.name });
		return { greeting: result.greeting, name: data.name };
	},
});

/**
 * `manualTrigger` — invoked from the trigger UI / tests with a typed `input`
 * and `output`. The manual caller receives the handler's return value.
 */
export const run = manualTrigger({
	input: z.object({ name: z.string().meta({ example: "world" }) }),
	output: z.object({ ok: z.boolean() }),
	handler: async ({ name }) => {
		await runDemo({ name });
		return { ok: true };
	},
});

/** An action that throws — drives the `action.error` / `trigger.error` path. */
export const boom = action({
	input: z.object({ reason: z.string() }),
	output: z.null(),
	handler: ({ reason }) => {
		throw new Error(`boom: ${reason}`);
	},
});

/** `manualTrigger` whose handler invokes the throwing action — failure demo. */
export const fail = manualTrigger({
	input: z.object({
		reason: z.string().meta({ example: "intentional example failure" }),
	}),
	output: z.null(),
	handler: async ({ reason }) => boom({ reason }),
});

/**
 * `imapTrigger` — polls an IMAP mailbox; each matching message fires the
 * handler with a parsed `msg`. The returned `{command}` is an IMAP command
 * batch applied to the current UID (here: mark `\Seen` so a message never
 * re-fires). `host`/`port`/credentials come from workflow env; the secret env
 * refs are sealed at build and resolved to plaintext by the runtime registry.
 *
 * Compile-validated here but needs a running IMAP server to actually run.
 */
export const inbound = imapTrigger({
	host: "localhost",
	port: 3993,
	tls: "required",
	insecureSkipVerify: true,
	user: workflow.env.IMAP_USER,
	password: workflow.env.IMAP_PASSWORD,
	folder: "INBOX",
	search: "UNSEEN",
	handler: async (msg) => {
		try {
			await runDemo({ name: msg.subject || "email" });
		} catch (err) {
			// biome-ignore lint/suspicious/noConsole: intentional — shows handler-internal error capture; the disposition still applies so the message is not re-fired
			console.log(
				`inbound handler caught: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return { command: [`UID STORE ${msg.uid} +FLAGS (\\Seen)`] };
	},
});

// -----------------------------------------------------------------------------
// `defineQueue` — a small durable FIFO scoped to this workflow. Items survive
// across invocations, capped at 1000 entries × 1024 bytes each. The
// `(owner, repo, workflow, queueName)` identity makes the queue invisible to
// any other workflow. Producer and consumer are separate triggers.
// -----------------------------------------------------------------------------

/**
 * `defineQueue({schema})` — the build derives JSON Schema and seeds an empty
 * file at upload; the runtime validates on both `put` and `get`.
 */
export const jobs = defineQueue({
	schema: z.object({
		url: z.string().meta({ example: "https://example.com" }),
		note: z.exactOptional(z.string().max(JOB_NOTE_MAX)),
	}),
});

/**
 * Producer: an HTTP webhook puts the validated body straight onto the queue.
 * The optional `key` routes the item to a partition (mailbox) within the queue;
 * omitted → the unkeyed partition. `key` is addressing, not part of the item,
 * so it is kept out of the queue schema.
 */
export const enqueueJob = httpTrigger({
	method: "POST",
	request: {
		body: z.object({
			url: z.string(),
			note: z.exactOptional(z.string().max(JOB_NOTE_MAX)),
			key: z.exactOptional(z.string()),
		}),
	},
	handler: async ({ body }) => {
		const { key, ...job } = body;
		await jobs.put(job, key);
		return { status: 202, body: { enqueued: true } };
	},
});

/**
 * Consumer: drains up to N items from a partition; `get(key)` pops FIFO within
 * that key only (omitted → the unkeyed partition) and returns `undefined` when
 * the partition is empty. Queue ops are serial by nature — each pop must
 * observe the previous pop's result, so they cannot be fanned out with
 * `Promise.all`.
 */
export const drainOnce = manualTrigger({
	input: z.object({
		max: z
			.number()
			.int()
			.min(1)
			.max(DRAIN_MAX_ITEMS)
			.default(DRAIN_DEFAULT_ITEMS),
		key: z.exactOptional(z.string()),
	}),
	output: z.object({
		drained: z.array(
			z.object({
				url: z.string(),
				note: z.exactOptional(z.string()),
			}),
		),
	}),
	handler: async ({ max, key }) => {
		const drained: { url: string; note?: string }[] = [];
		for (let i = 0; i < max; i++) {
			// biome-ignore lint/performance/noAwaitInLoops: queue ops are intentionally serial — `get()` removes the head item; each pop must observe the previous pop's result
			const item = await jobs.get(key);
			if (item === undefined) {
				break;
			}
			drained.push(item);
		}
		return { drained };
	},
});
