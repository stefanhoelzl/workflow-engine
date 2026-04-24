import {
	action,
	cronTrigger,
	defineWorkflow,
	env,
	httpTrigger,
	manualTrigger,
	secret,
	sendMail,
	z,
} from "@workflow-engine/sdk";

// Observable (WICG tentative) is not yet in TypeScript's lib.dom; declare the
// minimal shape the demo needs. Polyfill source:
// packages/sandbox-stdlib/src/web-platform/guest/observable.ts.
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

// Hoisted to module scope per `lint/performance/useTopLevelRegex`. Used by
// `sendDemo` to extract ethereal.email's preview-message id from the raw SMTP
// `250 Accepted` response string (matches nodemailer's own getTestMessageUrl).
const ETHEREAL_MSGID_RE = /MSGID=([^\s\]]+)/;

export const workflow = defineWorkflow({
	env: {
		GREETING_PREFIX: env({ default: "Hello" }),
		WEBHOOK_TOKEN: env({ secret: true }),
	},
});

export const greet = action({
	input: z.object({ name: z.string() }),
	output: z.string(),
	handler: async ({ name }) => `${workflow.env.GREETING_PREFIX}, ${name}!`,
});

export const shout = action({
	input: z.object({ name: z.string() }),
	output: z.string(),
	handler: async ({ name }) => (await greet({ name })).toUpperCase(),
});

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

export const uuid = action({
	input: z.object({}),
	output: z.object({ uuid: z.string() }),
	handler: async () => ({ uuid: crypto.randomUUID() }),
});

export const delay = action({
	input: z.object({ ms: z.number() }),
	output: z.object({ delayedMs: z.number() }),
	handler: async ({ ms }) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return { delayedMs: ms };
	},
});

export const parseUrl = action({
	input: z.object({ url: z.string() }),
	output: z.object({
		host: z.string(),
		query: z.record(z.string(), z.string()),
	}),
	handler: ({ url }) => {
		const parsed = new URL(url);
		const params = new URLSearchParams(parsed.search);
		const query: Record<string, string> = {};
		params.forEach((value, key) => {
			query[key] = value;
		});
		return Promise.resolve({ host: parsed.host, query });
	},
});

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
		// biome-ignore lint/suspicious/noConsole: intentional — demo.ts exercises the scrubber by logging known plaintexts
		console.log(
			`signing ${subject} with ${workflow.env.WEBHOOK_TOKEN}; sig=${sig}`,
		);
		return { sig };
	},
});

export const fetchEcho = action({
	input: z.object({ payload: z.object({ hello: z.string() }) }),
	output: z.object({ get: z.unknown(), post: z.unknown() }),
	handler: async ({ payload }) => {
		const getResponse = await fetch("https://httpbin.org/get");
		// biome-ignore lint/suspicious/noConsole: intentional — demo.ts documents the sandbox-stdlib `console` surface for workflow authors
		console.log(`GET httpbin.org/get -> ${getResponse.status}`);
		const get = await getResponse.json();

		const postResponse = await fetch("https://httpbin.org/post", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		// biome-ignore lint/suspicious/noConsole: intentional — demo.ts documents the sandbox-stdlib `console` surface for workflow authors
		console.log(`POST httpbin.org/post -> ${postResponse.status}`);
		const post = await postResponse.json();

		return { get, post };
	},
});

// Demonstrates error handling around fetch — a bad URL triggers a thrown
// TypeError from the shim, which the handler surfaces as a structured result
// instead of letting it become an uncaught action error.
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
// sandbox-stdlib Web Platform surface (see SECURITY.md §2 and
// packages/sandbox-stdlib/src/web-platform/guest/entry.ts for install order).
// Each action exercises at least one global per category so that regressions
// in the polyfill install chain surface in this workflow's bundle.
// -----------------------------------------------------------------------------

// performance.mark / performance.measure (user-timing polyfill).
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

// EventTarget / Event / CustomEvent (event-target polyfill).
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

// AbortController / AbortSignal (event-target polyfill). fetch.signal is not
// plumbed across the host bridge (see fetch.ts header comment), so the demo
// exercises the controller/signal object shape rather than live cancellation.
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

// scheduler.postTask (scheduler-polyfill). Uses user-blocking priority so the
// task runs on the next macrotask boundary even under load.
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

// Observable.subscribe (observable-polyfill, WICG tentative).
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
		};
	},
});

export const ping = httpTrigger({
	method: "GET",
	handler: async () => {
		const result = await runDemo({ name: "http-get" });
		return { status: 200, body: result };
	},
});

export const echo = httpTrigger({
	body: z.object({ name: z.string().meta({ example: "world" }) }),
	handler: async ({ body }) => {
		const result = await runDemo({ name: body.name });
		return { status: 200, body: result };
	},
});

// httpTrigger with `responseBody` — the SDK makes the response `body` field
// required and validates it against the schema at handler return. Contrast
// with `ping` / `echo` above, where all response fields are optional.
export const greetJson = httpTrigger({
	method: "POST",
	body: z.object({ name: z.string().meta({ example: "world" }) }),
	responseBody: z.object({ greeting: z.string() }),
	handler: async ({ body }) => {
		const greeting = await greet({ name: body.name });
		return { status: 200, body: { greeting } };
	},
});

export const everyFiveMinutes = cronTrigger({
	schedule: "*/5 * * * *",
	tz: "UTC",
	handler: async () => {
		await runDemo({ name: "cron-utc" });
	},
});

export const dailyBerlin = cronTrigger({
	schedule: "0 9 * * *",
	tz: "Europe/Berlin",
	handler: async () => {
		await runDemo({ name: "cron-berlin" });
	},
});

// Callable-style cron invocation — cronTrigger returns a branded callable, so
// tests (and other workflow code) can fire it directly without going through
// the scheduler. The scheduler discards the return value; callable-style
// usage preserves `Promise<unknown>` per cron-trigger/spec.md §1.
export const fireCron = httpTrigger({
	method: "POST",
	handler: async () => {
		await everyFiveMinutes();
		return { status: 202, body: { fired: "everyFiveMinutes" } };
	},
});

export const run = manualTrigger({
	input: z.object({ name: z.string().meta({ example: "world" }) }),
	output: z.object({ ok: z.boolean() }),
	handler: async ({ name }) => {
		await runDemo({ name });
		return { ok: true };
	},
});

// `sendDemo` exercises the mail plugin end-to-end using ethereal.email: we
// bootstrap throwaway SMTP credentials via the public nodemailer REST endpoint,
// then send a tiny message through them. Ethereal captures the message and
// returns a `viewUrl` the operator can click to see it — nothing is actually
// delivered. Kept out of `runDemo` so a transient outage of
// `api.nodemailer.com` cannot break every other demo trigger.
export const sendDemo = action({
	input: z.object({ to: z.string() }),
	output: z.object({ messageId: z.string(), viewUrl: z.string() }),
	handler: async ({ to }) => {
		const bootstrapRes = await fetch("https://api.nodemailer.com/user", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestor: "workflow-engine-demo",
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
			from: `"Workflow Engine Demo" <${creds.user}>`,
			to,
			subject: "Hello from workflow-engine",
			text: "This demo was sent via the sandbox-stdlib mail plugin.",
		});

		// Ethereal encodes its preview-URL id as `MSGID=<id>` inside the raw
		// SMTP `250 Accepted` response string (what nodemailer's own
		// `getTestMessageUrl` parses). `creds.web` already includes the
		// scheme.
		const msgIdMatch = (result.response ?? "").match(ETHEREAL_MSGID_RE);
		const previewId = msgIdMatch?.[1];
		const viewUrl = previewId
			? `${creds.web}/message/${previewId}`
			: `${creds.web}/messages`;
		return { messageId: result.messageId, viewUrl };
	},
});

export const sendMailDemo = manualTrigger({
	input: z.object({
		to: z.string().meta({ example: "demo@example.com" }),
	}),
	output: z.object({ messageId: z.string(), viewUrl: z.string() }),
	handler: async ({ to }) => sendDemo({ to }),
});

export const boom = action({
	input: z.object({ reason: z.string() }),
	output: z.null(),
	handler: ({ reason }) => {
		throw new Error(`boom: ${reason}`);
	},
});

export const fail = manualTrigger({
	input: z.object({
		reason: z.string().meta({ example: "intentional demo failure" }),
	}),
	output: z.null(),
	handler: async ({ reason }) => boom({ reason }),
});
