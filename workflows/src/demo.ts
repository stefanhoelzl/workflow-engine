import {
	action,
	cronTrigger,
	defineWorkflow,
	env,
	httpTrigger,
	manualTrigger,
	secret,
	z,
} from "@workflow-engine/sdk";

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
		return {
			greeting,
			shouted,
			hash: hashed,
			uuid: uuidResult,
			delay: delayed,
			parsed,
			signed,
			fetched,
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

export const run = manualTrigger({
	input: z.object({ name: z.string().meta({ example: "world" }) }),
	output: z.object({ ok: z.boolean() }),
	handler: async ({ name }) => {
		await runDemo({ name });
		return { ok: true };
	},
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
